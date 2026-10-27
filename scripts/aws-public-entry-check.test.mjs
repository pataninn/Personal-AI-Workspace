import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const publicEntry = JSON.parse(readFileSync(new URL('../deploy/aws/public-entry.template.json', import.meta.url), 'utf8'));
const originAccess = JSON.parse(readFileSync(new URL('../deploy/aws/origin-access.template.json', import.meta.url), 'utf8'));
const nginx = readFileSync(new URL('../deploy/aws/nginx.conf.example', import.meta.url), 'utf8');
const uploadRoutes = readFileSync(new URL('../backend/src/modules/files/controllers/project-file-action-routes.ts', import.meta.url), 'utf8');

const resourceByType = (template, type) => Object.values(template.Resources).find((resource) => resource.Type === type);

test('the VPC origin targets only the private Sydney EC2 endpoint over HTTP 8080', () => {
  const origin = resourceByType(publicEntry, 'AWS::CloudFront::VpcOrigin');
  const config = origin.Properties.VpcOriginEndpointConfig;

  assert.deepEqual(config.Arn, {
    'Fn::Sub': 'arn:${AWS::Partition}:ec2:${HostRegion}:${AWS::AccountId}:instance/${HostInstanceId}'
  });
  assert.equal(publicEntry.Parameters.HostRegion.Default, 'ap-southeast-2');
  assert.deepEqual(publicEntry.Parameters.HostRegion.AllowedValues, ['ap-southeast-2']);
  assert.equal(config.HTTPPort, 8080);
  assert.equal(config.OriginProtocolPolicy, 'http-only');
  assert.equal(publicEntry.Resources.PublicEntryDistribution.Properties.DistributionConfig.Origins[0].DomainName.Ref, 'OriginDomainName');
  assert.deepEqual(publicEntry.Resources.PublicEntryDistribution.Properties.DistributionConfig.Origins[0].VpcOriginConfig.VpcOriginId, { Ref: 'PrivateHostVpcOrigin' });
  assert.equal(publicEntry.Resources.PublicEntryDistribution.Properties.DistributionConfig.Origins[0].CustomOriginConfig, undefined);
});

test('the distribution starts disabled and uses HTTPS with no-cache app request forwarding', () => {
  const distribution = publicEntry.Resources.PublicEntryDistribution.Properties.DistributionConfig;
  const behavior = distribution.DefaultCacheBehavior;
  const originRequestPolicy = publicEntry.Resources.AppOriginRequestPolicy.Properties.OriginRequestPolicyConfig;
  const originConfig = distribution.Origins[0].VpcOriginConfig;

  assert.equal(publicEntry.Parameters.DistributionEnabled.Default, 'false');
  assert.match(publicEntry.Parameters.DistributionEnabled.Description, /false for private preparation and budget review/);
  assert.match(publicEntry.Parameters.DistributionEnabled.Description, /controlled browser acceptance while the global AI pause remains enabled/);
  assert.deepEqual(distribution.Enabled, { 'Fn::If': ['DistributionIsEnabled', true, false] });
  assert.deepEqual(publicEntry.Conditions.DistributionIsEnabled, { 'Fn::Equals': [{ Ref: 'DistributionEnabled' }, 'true'] });
  assert.match(publicEntry.Resources.PublicEntryDistribution.Metadata['com.aws.cloudformation.Context'].must.join(' '), /hold general public release until acceptance passes/);
  assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.deepEqual(behavior.AllowedMethods, ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  assert.equal(behavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.deepEqual(behavior.OriginRequestPolicyId, { Ref: 'AppOriginRequestPolicy' });
  assert.equal(originRequestPolicy.Name.Ref, 'AWS::StackName');
  assert.equal(originRequestPolicy.HeadersConfig.HeaderBehavior, 'allViewerAndWhitelistCloudFront');
  assert.deepEqual(originRequestPolicy.HeadersConfig.Headers, ['CloudFront-Viewer-Address']);
  assert.deepEqual(originRequestPolicy.CookiesConfig, { CookieBehavior: 'all' });
  assert.deepEqual(originRequestPolicy.QueryStringsConfig, { QueryStringBehavior: 'all' });
  assert.equal(originConfig.OriginReadTimeout, 30);
  assert.equal(originConfig.OriginKeepaliveTimeout, undefined);
  assert.equal(behavior.ResponseHeadersPolicyId, '67f7725c-6f97-4210-82d7-5512b31e9d03');
  assert.deepEqual(Object.values(publicEntry.Resources).map(({ Type }) => Type).sort(), [
    'AWS::CloudFront::Distribution',
    'AWS::CloudFront::OriginRequestPolicy',
    'AWS::CloudFront::VpcOrigin'
  ]);
  assert.equal(distribution.Aliases, undefined);
  assert.deepEqual(distribution.ViewerCertificate, { CloudFrontDefaultCertificate: true });
  assert.equal(distribution.WebACLId, undefined);
  assert.equal(publicEntry.Parameters.PriceClass.Default, undefined);
});

test('origin ingress accepts only the CloudFront service-managed group on TCP 8080', () => {
  const ingress = resourceByType(originAccess, 'AWS::EC2::SecurityGroupIngress').Properties;

  assert.equal(ingress.IpProtocol, 'tcp');
  assert.equal(ingress.FromPort, 8080);
  assert.equal(ingress.ToPort, 8080);
  assert.deepEqual(ingress.GroupId, { Ref: 'HostSecurityGroupId' });
  assert.deepEqual(ingress.SourceSecurityGroupId, { Ref: 'CloudFrontServiceSecurityGroupId' });
  assert.equal(ingress.CidrIp, undefined);
  assert.equal(ingress.CidrIpv6, undefined);
  assert.deepEqual(originAccess.Parameters.CloudFrontServiceSecurityGroupId.Type, 'AWS::EC2::SecurityGroup::Id');
});

test('Nginx verifies app TLS, respects upload limits, and streams without sensitive logging or buffering', () => {
  assert.match(nginx, /listen\s+8080;/);
  assert.deepEqual([...nginx.matchAll(/^\s*listen\s+(\d+);/gm)].map(([, port]) => port), ['8080']);
  const appLimitMegabytes = uploadRoutes.match(/express\.raw\(\{[^}]*limit:\s*'(\d+)mb'/s)?.[1];
  const proxyLimitMegabytes = nginx.match(/^\s*client_max_body_size\s+(\d+)m;/m)?.[1];
  assert.equal(appLimitMegabytes, '8');
  assert.equal(proxyLimitMegabytes, appLimitMegabytes);
  const accessLogFormat = nginx.match(/^\s*log_format\s+personal_ai_proxy\s+'([^']*)';/m)?.[1];
  assert.equal(accessLogFormat, '$request_method $status $upstream_status $request_time');
  assert.match(nginx, /^\s*access_log\s+\/var\/log\/nginx\/personal-ai-proxy\.log personal_ai_proxy;/m);
  assert.match(nginx, /^\s*error_log\s+\/dev\/null crit;/m);
  assert.doesNotMatch(accessLogFormat, /\$(?:request_uri|request|args|remote_addr|http_[a-z0-9_]+)\b/);
  assert.match(nginx, /proxy_pass\s+https:\/\/127\.0\.0\.1:8443;/);
  assert.match(nginx, /proxy_ssl_verify\s+on;/);
  assert.match(nginx, /proxy_ssl_trusted_certificate\s+\S+;/);
  assert.match(nginx, /proxy_ssl_server_name\s+on;/);
  assert.match(nginx, /proxy_ssl_name\s+\S+;/);
  assert.match(nginx, /proxy_buffering\s+off;/);
  assert.match(nginx, /proxy_request_buffering\s+off;/);
  assert.match(nginx, /proxy_cache\s+off;/);
  assert.match(nginx, /15 seconds/);
  assert.match(nginx, /proxy_read_timeout\s+60s;/);
  assert.doesNotMatch(nginx, /proxy_ssl_verify\s+off;/);
});

test('Nginx trusts CloudFront viewer IP only behind the private origin path and overwrites forwarded IP headers', () => {
  assert.match(nginx, /set_real_ip_from\s+10\.0\.0\.0\/16;/);
  assert.match(nginx, /real_ip_header\s+CloudFront-Viewer-Address;/);
  assert.match(nginx, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
  assert.match(nginx, /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/);
  assert.match(nginx, /proxy_set_header\s+X-Forwarded-Proto\s+https;/);
  assert.match(nginx, /proxy_set_header\s+Origin\s+\$http_origin;/);
  assert.match(nginx, /proxy_set_header\s+Host\s+\$host;/);
  assert.match(nginx, /proxy_set_header\s+Cookie\s+\$http_cookie;/);
  assert.match(nginx, /proxy_set_header\s+X-CSRF-Token\s+\$http_x_csrf_token;/);
  assert.match(nginx, /proxy_set_header\s+Idempotency-Key\s+\$http_idempotency_key;/);
  assert.match(nginx, /exact \/32/);
  assert.doesNotMatch(nginx, /set_real_ip_from\s+(0\.0\.0\.0\/0|::\/0);/);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
});

test('Nginx leaves origin security headers and cookies intact', () => {
  assert.match(nginx, /proxy_set_header\s+Cookie\s+\$http_cookie;/);
  assert.doesNotMatch(nginx, /^\s*add_header\s/m);
  assert.doesNotMatch(nginx, /^\s*proxy_hide_header\s/m);
  assert.match(nginx, /preserve viewer Origin and cookies/i);
  assert.match(publicEntry.Resources.PublicEntryDistribution.Metadata['com.aws.cloudformation.Context'].why, /does not define or replace CSP/);
});
