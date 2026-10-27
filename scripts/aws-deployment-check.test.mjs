import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = JSON.parse(readFileSync(new URL('../deploy/aws/host.template.json', import.meta.url), 'utf8'));
const { Resources: resources, Parameters: parameters } = template;

test('the AWS foundation cannot expose the app, database or bridge on launch', () => {
  assert.deepEqual(resources.HostSecurityGroup.Properties.SecurityGroupIngress, []);
  const interfaces = resources.Host.Properties.NetworkInterfaces;
  assert.equal(interfaces.length, 1);
  assert.equal(interfaces[0].AssociatePublicIpAddress, false);
  assert.deepEqual(interfaces[0].GroupSet, [{ Ref: 'HostSecurityGroup' }]);
  const allowedTypes = new Set(['AWS::EC2::Instance', 'AWS::EC2::SecurityGroup', 'AWS::IAM::Role', 'AWS::IAM::InstanceProfile', 'AWS::EC2::Volume', 'AWS::EC2::VolumeAttachment']);
  Object.values(resources).forEach((resource) => assert.ok(allowedTypes.has(resource.Type), `Review added infrastructure type: ${resource.Type}`));
  assert.deepEqual(resources.HostSecurityGroup.Properties.SecurityGroupEgress.map(({ IpProtocol, FromPort, ToPort, CidrIp }) => ({ IpProtocol, FromPort, ToPort, CidrIp })), [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }]);
});

test('persistent data is encrypted and retained when the stack or volume is replaced', () => {
  assert.equal(resources.DataVolume.Properties.Encrypted, true);
  assert.equal(resources.DataVolume.DeletionPolicy, 'Retain');
  assert.equal(resources.DataVolume.UpdateReplacePolicy, 'Retain');
  assert.equal(resources.Host.Properties.BlockDeviceMappings[0].Ebs.Encrypted, true);
  assert.deepEqual(resources.DataAttachment.Properties.VolumeId, { Ref: 'DataVolume' });
  assert.deepEqual(resources.DataVolume.Properties.AvailabilityZone, { 'Fn::GetAtt': ['Host', 'AvailabilityZone'] });
});

test('host credentials require IMDSv2 and the instance role grants only SSM core access', () => {
  assert.equal(resources.Host.Properties.MetadataOptions.HttpTokens, 'required');
  assert.equal(resources.Host.Properties.MetadataOptions.HttpPutResponseHopLimit, 1);
  assert.deepEqual(resources.HostRole.Properties.ManagedPolicyArns, [{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore' }]);
  assert.equal(resources.HostRole.Properties.Policies, undefined);
  assert.equal(resources.Host.Properties.KeyName, undefined);
  assert.equal(resources.Host.Properties.UserData, undefined);
});

test('network, image and spending-related capacity inputs require explicit operator choices', () => {
  for (const name of ['VpcId', 'SubnetId', 'ImageId', 'RootDeviceName', 'InstanceType', 'RootVolumeGiB', 'DataVolumeGiB']) assert.equal(parameters[name].Default, undefined, name);
  const example = JSON.parse(readFileSync(new URL('../deploy/aws/parameters.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.map((item) => item.ParameterKey).sort(), Object.keys(parameters).sort());
  example.forEach((item) => assert.match(item.ParameterValue, /^REPLACE_WITH_/));
});
