import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (name) => readFileSync(new URL(`../deploy/aws/${name}`, import.meta.url), 'utf8');
const network = JSON.parse(read('demo-network.template.json'));
const host = JSON.parse(read('demo-host.template.json'));
const proxy = read('nginx-demo.conf.example');
const bootstrap = read('nginx-demo-bootstrap.conf.example');
const httpsSetup = read('configure-demo-https.sh');

test('the small demo has one internet route and no NAT, CloudFront, load balancer or paid endpoint', () => {
  const types = Object.values(network.Resources).map(({ Type }) => Type);
  assert.equal(types.filter((type) => type === 'AWS::EC2::Subnet').length, 1);
  const allowed = new Set(['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::RouteTable', 'AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation']);
  types.forEach((type) => assert.ok(allowed.has(type), type));
  assert.equal(network.Resources.PublicSubnet.Properties.MapPublicIpOnLaunch, false);
  assert.deepEqual(network.Resources.PublicDefaultRoute.Properties.GatewayId, { Ref: 'InternetGateway' });
  assert.deepEqual(network.Outputs.HostSubnetId.Value, { Ref: 'PublicSubnet' });
});

test('public access starts closed and enabling it exposes only ACME and HTTPS', () => {
  assert.equal(host.Parameters.EnableWebIngress.Default, 'false');
  assert.deepEqual(host.Conditions.WebIngressEnabled, { 'Fn::Equals': [{ Ref: 'EnableWebIngress' }, 'true'] });
  const [condition, enabled, disabled] = host.Resources.HostSecurityGroup.Properties.SecurityGroupIngress['Fn::If'];
  assert.equal(condition, 'WebIngressEnabled');
  assert.deepEqual(disabled, []);
  assert.deepEqual(enabled.map(({ IpProtocol, FromPort, ToPort, CidrIp }) => [IpProtocol, FromPort, ToPort, CidrIp]), [['tcp', 80, 80, '0.0.0.0/0'], ['tcp', 443, 443, '0.0.0.0/0']]);
  assert.deepEqual(host.Resources.HostSecurityGroup.Properties.SecurityGroupEgress.map(({ FromPort, ToPort }) => [FromPort, ToPort]), [[443, 443]]);
  assert.equal(host.Resources.Host.Properties.KeyName, undefined);
  assert.deepEqual(host.Resources.Host.Properties.MetadataOptions, { HttpEndpoint: 'enabled', HttpTokens: 'required', HttpPutResponseHopLimit: 1, InstanceMetadataTags: 'disabled' });
});

test('the small candidate has explicit CPU surplus protection and encrypted retained data', () => {
  assert.equal(host.Parameters.InstanceType.Default, 't3.small');
  assert.equal(host.Parameters.RootVolumeGiB.Default, 20);
  assert.equal(host.Parameters.DataVolumeGiB.Default, 20);
  assert.deepEqual(host.Parameters.InstanceType.AllowedValues, ['t3.small', 'c7i-flex.large', 'm7i-flex.large']);
  assert.deepEqual(host.Resources.Host.Properties.CreditSpecification, { 'Fn::If': ['IsT3', { CPUCredits: 'standard' }, { Ref: 'AWS::NoValue' }] });
  assert.deepEqual(host.Conditions.IsT3, { 'Fn::Equals': [{ Ref: 'InstanceType' }, 't3.small'] });
  assert.equal(host.Resources.Host.Properties.NetworkInterfaces[0].AssociatePublicIpAddress, false);
  assert.equal(host.Resources.PublicAddress.Type, 'AWS::EC2::EIP');
  assert.deepEqual(host.Resources.PublicAddressAssociation.Properties.InstanceId, { Ref: 'Host' });
  assert.equal(host.Resources.DataVolume.Properties.Encrypted, true);
  assert.equal(host.Resources.DataVolume.DeletionPolicy, 'Retain');
  assert.equal(host.Resources.DataVolume.UpdateReplacePolicy, 'Retain');
  assert.equal(host.Resources.Host.Properties.BlockDeviceMappings[0].Ebs.Encrypted, true);
  const example = JSON.parse(read('parameters.small-demo.example.json'));
  assert.deepEqual(example.map(({ ParameterKey }) => ParameterKey).sort(), Object.keys(host.Parameters).sort());
  assert.equal(example.find(({ ParameterKey }) => ParameterKey === 'EnableWebIngress').ParameterValue, 'false');
  assert.equal(example.find(({ ParameterKey }) => ParameterKey === 'InstanceType').ParameterValue, 't3.small');
  for (const name of ['RootVolumeGiB', 'DataVolumeGiB']) {
    assert.equal(example.find(({ ParameterKey }) => ParameterKey === name).ParameterValue, '20');
  }
});

test('HTTP bootstrap never proxies the app and final HTTP only serves ACME or fixed-IP HTTPS redirects', () => {
  for (const config of [bootstrap, proxy.split('listen 443')[0]]) {
    assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//);
    assert.match(config, /try_files \$uri =404/);
    assert.doesNotMatch(config, /proxy_pass/);
    assert.match(config, /if \(\$host != REPLACE_WITH_PUBLIC_IP\)/);
  }
  assert.match(bootstrap, /location \/ \{ return 404; \}/);
  assert.match(proxy, /return 308 https:\/\/REPLACE_WITH_PUBLIC_IP\$request_uri/);
  assert.doesNotMatch(proxy, /return 308 https:\/\/\$host/);
});

test('direct HTTPS verifies both TLS hops, replaces forged IP headers and preserves streaming and uploads', () => {
  assert.match(proxy, /listen 443 ssl/);
  assert.match(proxy, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(proxy, /proxy_ssl_verify on/);
  assert.match(proxy, /proxy_ssl_trusted_certificate/);
  assert.match(proxy, /proxy_set_header X-Forwarded-For \$remote_addr/);
  assert.doesNotMatch(proxy, /set_real_ip_from|real_ip_header|proxy_add_x_forwarded_for/);
  assert.match(proxy, /proxy_set_header CloudFront-Viewer-Address ""/);
  assert.match(proxy, /client_max_body_size 8m/);
  assert.match(proxy, /proxy_buffering off/);
  assert.match(proxy, /proxy_request_buffering off/);
  assert.match(proxy, /proxy_read_timeout 60s/);
  assert.match(proxy, /proxy_set_header Origin \$http_origin/);
  assert.match(proxy, /proxy_set_header Cookie \$http_cookie/);
  assert.match(proxy, /proxy_set_header X-CSRF-Token \$http_x_csrf_token/);
  assert.match(proxy, /log_format personal_ai_demo '\$request_method \$status \$upstream_status \$request_time'/);
  assert.match(proxy, /error_log \/dev\/null crit/);
});

test('IP certificate renewal requires the retained mount and validates Nginx before reloading', () => {
  const service = read('pai-cert-renew.service');
  const timer = read('pai-cert-renew.timer');
  assert.match(service, /RequiresMountsFor=\/mnt\/pai-data/);
  assert.match(service, /ExecStartPre=\/usr\/bin\/mountpoint -q \/mnt\/pai-data/);
  assert.match(service, /--config-dir \/mnt\/pai-data\/letsencrypt/);
  assert.match(service, /--deploy-hook "\/usr\/sbin\/nginx -t && \/bin\/systemctl reload nginx"/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00,12:00:00 UTC/);
  assert.match(timer, /OnBootSec=5min/);
  assert.match(timer, /Persistent=true/);
});

test('numeric EIP probes route locally while retaining the public IP URL for Host and TLS checks', () => {
  assert.match(httpsSetup, /--connect-to "\$PUBLIC_IP:80:127\.0\.0\.1:80"[^\n]+"http:\/\/\$PUBLIC_IP\//);
  assert.match(httpsSetup, /--connect-to "\$PUBLIC_IP:443:127\.0\.0\.1:443"[^\n]+"https:\/\/\$PUBLIC_IP\/health"/);
  assert.doesNotMatch(httpsSetup, /--resolve "\$PUBLIC_IP:(?:80|443):127\.0\.0\.1"/);
  assert.doesNotMatch(httpsSetup, /(^|\s)(-k|--insecure)(\s|$)/);
});

test('bootstrap reloads active Nginx before probing its listener and challenge route', () => {
  const prepareStart = httpsSetup.indexOf('if [[ "$PHASE" == prepare ]]; then');
  const prepareEnd = httpsSetup.indexOf('\nassert_mounted_data\n', prepareStart);
  const prepare = httpsSetup.slice(prepareStart, prepareEnd);
  const enabled = prepare.indexOf('/bin/systemctl enable --now nginx');
  const active = prepare.indexOf('/bin/systemctl is-active --quiet nginx');
  const reloaded = prepare.indexOf('/bin/systemctl reload nginx');
  const listener = prepare.indexOf('assert_listener 80');
  const probe = prepare.indexOf('probe_http_challenge');
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  assert.ok(enabled >= 0 && enabled < active);
  assert.ok(active < reloaded && reloaded < listener && listener < probe);
});

test('Nginx readiness waits are bounded and require exact challenge content and HTTP 200', () => {
  const challengeStart = httpsSetup.indexOf('probe_http_challenge() {');
  const challengeEnd = httpsSetup.indexOf('\n}', challengeStart);
  const challengeProbe = httpsSetup.slice(challengeStart, challengeEnd);
  const listenerStart = httpsSetup.indexOf('assert_listener() {');
  const listenerEnd = httpsSetup.indexOf('\n}', listenerStart);
  const listenerProbe = httpsSetup.slice(listenerStart, listenerEnd);
  const httpsStart = httpsSetup.indexOf('verify_final_https() {');
  const httpsEnd = httpsSetup.indexOf('\n}', httpsStart);
  const httpsProbe = httpsSetup.slice(httpsStart, httpsEnd);
  assert.match(httpsSetup, /readonly READINESS_ATTEMPTS=6/);
  assert.match(challengeProbe, /for \(\(attempt = 1; attempt <= READINESS_ATTEMPTS; attempt \+= 1\)\)/);
  assert.match(challengeProbe, /cmp -s -- "\$WORK_DIR\/http-probe" "\$token_file"/);
  assert.match(listenerProbe, /for \(\(attempt = 1; attempt <= READINESS_ATTEMPTS; attempt \+= 1\)\)/);
  assert.match(httpsProbe, /for \(\(attempt = 1; attempt <= READINESS_ATTEMPTS; attempt \+= 1\)\)/);
  assert.match(httpsProbe, /\[\[ "\$status" == 200 \]\]/);
});
