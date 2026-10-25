import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = JSON.parse(readFileSync(new URL('../deploy/aws/network.template.json', import.meta.url), 'utf8'));
const { Resources: resources, Parameters: parameters, Outputs: outputs } = template;
const ref = (name) => ({ Ref: name });

test('the network requires explicit, syntactically valid private CIDRs and one operator-selected AZ', () => {
  const cidrParameters = ['VpcCidr', 'PublicSubnetCidr', 'PrivateSubnetCidr'];
  for (const name of [...cidrParameters, 'AvailabilityZone']) assert.equal(parameters[name].Default, undefined, name);
  for (const name of cidrParameters) {
    assert.equal(parameters[name].Type, 'String');
    const allowed = new RegExp(parameters[name].AllowedPattern);
    for (const value of ['10.0.0.0/16', '10.20.1.0/24', '172.16.0.0/16', '172.31.255.240/28', '192.168.4.0/24']) {
      assert.match(value, allowed, `${name} should accept ${value}`);
    }
    for (const value of ['8.8.8.0/24', '172.32.0.0/16', '192.169.0.0/24', '10.0.0/24', '10.0.0.0/15', '192.168.0.0/29']) {
      assert.doesNotMatch(value, allowed, `${name} should reject ${value}`);
    }
  }
  assert.equal(parameters.AvailabilityZone.Type, 'AWS::EC2::AvailabilityZone::Name');
});

test('the two subnets and one public NAT gateway share the explicitly selected AZ', () => {
  assert.deepEqual(resources.PublicSubnet.Properties.VpcId, ref('Vpc'));
  assert.deepEqual(resources.PrivateSubnet.Properties.VpcId, ref('Vpc'));
  assert.deepEqual(resources.PublicSubnet.Properties.CidrBlock, ref('PublicSubnetCidr'));
  assert.deepEqual(resources.PrivateSubnet.Properties.CidrBlock, ref('PrivateSubnetCidr'));
  assert.deepEqual(resources.PublicSubnet.Properties.AvailabilityZone, ref('AvailabilityZone'));
  assert.deepEqual(resources.PrivateSubnet.Properties.AvailabilityZone, ref('AvailabilityZone'));
  assert.equal(resources.PublicSubnet.Properties.MapPublicIpOnLaunch, false);
  assert.equal(resources.PrivateSubnet.Properties.MapPublicIpOnLaunch, false);
  assert.deepEqual(resources.NatGateway.Properties.SubnetId, ref('PublicSubnet'));
  assert.deepEqual(resources.NatGateway.Properties.AllocationId, { 'Fn::GetAtt': ['NatEip', 'AllocationId'] });
  assert.equal(resources.NatGateway.Properties.ConnectivityType, 'public');
  assert.equal(resources.NatGateway.DependsOn, 'InternetGatewayAttachment');
  assert.deepEqual(resources.NatEip.Properties, { Domain: 'vpc' });
});

test('the route graph sends only private IPv4 default egress through NAT', () => {
  assert.deepEqual(resources.InternetGatewayAttachment.Properties, {
    VpcId: ref('Vpc'),
    InternetGatewayId: ref('InternetGateway')
  });
  assert.equal(resources.PublicDefaultRoute.DependsOn, 'InternetGatewayAttachment');
  assert.deepEqual(resources.PublicDefaultRoute.Properties, {
    RouteTableId: ref('PublicRouteTable'),
    DestinationCidrBlock: '0.0.0.0/0',
    GatewayId: ref('InternetGateway')
  });
  assert.deepEqual(resources.PrivateDefaultRoute.Properties, {
    RouteTableId: ref('PrivateRouteTable'),
    DestinationCidrBlock: '0.0.0.0/0',
    NatGatewayId: ref('NatGateway')
  });
  assert.equal(resources.PrivateDefaultRoute.DependsOn, 'NatGateway');
  assert.deepEqual(resources.PublicSubnetRouteTableAssociation.Properties, {
    SubnetId: ref('PublicSubnet'),
    RouteTableId: ref('PublicRouteTable')
  });
  assert.deepEqual(resources.PrivateSubnetRouteTableAssociation.Properties, {
    SubnetId: ref('PrivateSubnet'),
    RouteTableId: ref('PrivateRouteTable')
  });
});

test('the template contains one NAT and no host, ingress, SSH, load balancer, or extra egress tier', () => {
  const allowedTypes = new Set([
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::InternetGateway',
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::RouteTable',
    'AWS::EC2::Route',
    'AWS::EC2::SubnetRouteTableAssociation',
    'AWS::EC2::EIP',
    'AWS::EC2::NatGateway'
  ]);
  const values = Object.values(resources);
  const counts = Object.groupBy(values, ({ Type }) => Type);
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([type, items]) => [type, items.length])), {
    'AWS::EC2::VPC': 1,
    'AWS::EC2::Subnet': 2,
    'AWS::EC2::InternetGateway': 1,
    'AWS::EC2::VPCGatewayAttachment': 1,
    'AWS::EC2::RouteTable': 2,
    'AWS::EC2::Route': 2,
    'AWS::EC2::SubnetRouteTableAssociation': 2,
    'AWS::EC2::EIP': 1,
    'AWS::EC2::NatGateway': 1
  });
  values.forEach(({ Type, Properties }) => {
    assert.ok(allowedTypes.has(Type), `Unexpected network resource type: ${Type}`);
    assert.equal(Properties?.SecurityGroupIngress, undefined);
    assert.equal(Properties?.KeyName, undefined);
    assert.equal(Properties?.UserData, undefined);
  });
  assert.equal(template.Metadata.AWSToolsMetrics.AWSAgentToolkit, 'aws-cloudformation@3');
});

test('outputs identify the network inputs and embedded context preserves cost and data boundaries', () => {
  assert.deepEqual(Object.keys(outputs).sort(), ['AvailabilityZone', 'PrivateSubnetId', 'PublicSubnetId', 'VpcId'].sort());
  assert.deepEqual(outputs.VpcId.Value, ref('Vpc'));
  assert.deepEqual(outputs.PrivateSubnetId.Value, ref('PrivateSubnet'));
  assert.deepEqual(outputs.PublicSubnetId.Value, ref('PublicSubnet'));
  assert.deepEqual(outputs.AvailabilityZone.Value, ref('AvailabilityZone'));
  assert.match(template.Description, /NAT Gateway hourly\/data processing.*public IPv4 charges continue while the separate host is stopped/i);
  assert.match(template.Description, /deleting this stack leaves the host's separately retained data volume intact/i);
  assert.equal(template.Metadata['com.aws.cloudformation.Context'].must.length, 4);
  for (const resource of Object.values(resources)) {
    assert.ok(resource.Metadata?.['com.aws.cloudformation.Context']?.why, `${resource.Type} needs embedded rationale`);
  }
});
