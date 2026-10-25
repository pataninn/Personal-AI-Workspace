#!/usr/bin/env bash
# Fresh approved staging host only. The exact new EBS volume ID is mandatory.
set -euo pipefail
umask 027
[[ $EUID == 0 && $# == 1 && $1 =~ ^vol-[0-9a-f]+$ ]] || exit 2
volume_id=$1
serial=${volume_id//-/}
device_link=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${serial}
[[ -L $device_link ]] || { echo 'Expected EBS device identity not present'; exit 3; }
device=$(readlink -f "$device_link")
[[ $(lsblk -dn -o SERIAL "$device" | tr -d ' ') == "$serial" ]] || exit 4
[[ $(lsblk -dn -o TYPE "$device") == disk ]] || exit 5
[[ $(lsblk -n -o MOUNTPOINTS "$device" | sed '/^$/d' | wc -l) == 0 ]] || { echo 'Target device is already mounted; inspect before repeating'; exit 6; }
[[ $(lsblk -n -o NAME "$device" | wc -l) == 1 ]] || exit 7
[[ $(lsblk -bdn -o SIZE "$device") == 21474836480 ]] || exit 8
[[ -z $(wipefs -n --noheadings "$device") ]] || { echo 'Target is not pristine; refusing to format'; exit 9; }
mkfs.ext4 -q -L pai-demo-data "$device"
data_uuid=$(blkid -s UUID -o value "$device")
mkdir -p /mnt/pai-data
[[ -z $(find /mnt/pai-data -mindepth 1 -maxdepth 1 -print -quit) ]] || exit 10
printf '\n# Personal AI retained staging EBS (%s)\nUUID=%s /mnt/pai-data ext4 defaults,x-systemd.device-timeout=90s 0 2\n' "$volume_id" "$data_uuid" >> /etc/fstab
mount /mnt/pai-data
[[ $(findmnt -n -o UUID --target /mnt/pai-data) == "$data_uuid" ]] || exit 11
mkdir -p /mnt/pai-data/{docker,containerd,app,workspace,managed,private,runtime-home}
chmod 700 /mnt/pai-data/private

# The host security group deliberately permits outbound HTTPS only.
python3 - <<'PY'
from pathlib import Path
for path in [Path('/etc/apt/sources.list'), *Path('/etc/apt/sources.list.d').glob('*.sources'), *Path('/etc/apt/sources.list.d').glob('*.list')]:
    if not path.exists():
        continue
    text = path.read_text()
    import re
    text = re.sub(r'http://(?:[A-Za-z0-9.-]+\.)?ec2\.archive\.ubuntu\.com/ubuntu/?', 'https://archive.ubuntu.com/ubuntu/', text)
    text = text.replace('http://archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu')
    text = text.replace('http://security.ubuntu.com/ubuntu', 'https://security.ubuntu.com/ubuntu')
    path.write_text(text)
PY
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/var/log/pai-apt.log 2>&1
apt-get install -y -qq ca-certificates curl gnupg nginx python3-venv openssl jq snapd >>/var/log/pai-apt.log 2>&1
systemctl stop nginx
install -m 0755 -d /etc/apt/keyrings /etc/docker /etc/systemd/system/docker.service.d /etc/systemd/system/containerd.service.d
curl --fail --silent --show-error --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
# Both Docker and containerd store container state on the retained EBS filesystem.
printf '{"data-root":"/mnt/pai-data/docker","log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}\n' > /etc/docker/daemon.json
for service in docker containerd; do
    printf '[Unit]\nRequiresMountsFor=/mnt/pai-data\n[Service]\nExecStartPre=/usr/bin/mountpoint -q /mnt/pai-data\n' > "/etc/systemd/system/${service}.service.d/pai-data.conf"
done
apt-get update -qq >>/var/log/pai-apt.log 2>&1
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >>/var/log/pai-apt.log 2>&1
systemctl stop docker.service docker.socket containerd.service
[[ ! -e /mnt/pai-data/containerd/configured ]] || exit 12
install -d /etc/containerd
containerd config default > /etc/containerd/config.toml
sed -i 's#root = "/var/lib/containerd"#root = "/mnt/pai-data/containerd"#' /etc/containerd/config.toml
touch /mnt/pai-data/containerd/configured
systemctl daemon-reload
systemctl enable --now containerd docker
docker_version=$(docker version --format '{{.Server.Version}}')
[[ ${docker_version%%.*} -ge 28 ]] || exit 13
printf 'Base ready: EBS=%s Docker=%s\n' "$volume_id" "$docker_version"
free -m
df -h / /mnt/pai-data
