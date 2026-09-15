import { OpenShellGatewayClient, type FetchImplementation } from '@/infrastructure/sandbox/openshell-gateway-client';

describe('OpenShellGatewayClient', () => {
  it('sends authenticated health requests without exposing the token in errors', async () => {
    const fetchImplementation: jest.MockedFunction<FetchImplementation> = jest.fn().mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const client = new OpenShellGatewayClient({
      baseUrl: 'http://openshell-gateway:8080',
      clientId: 'app',
      clientToken: 'secret-token-1234',
      healthPath: '/health',
      nimReadinessPath: '/v1/provider/readiness',
      timeoutMs: 500,
      fetchImplementation
    });

    await client.checkHealth();

    expect(fetchImplementation).toHaveBeenCalledWith(
      'http://openshell-gateway:8080/health',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token-1234',
          'X-OpenShell-Client-Id': 'app'
        })
      })
    );
  });

  it('rejects malformed NIM readiness payloads', async () => {
    const fetchImplementation: jest.MockedFunction<FetchImplementation> = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ready: true }), { status: 200 })
    );
    const client = new OpenShellGatewayClient({
      baseUrl: 'http://openshell-gateway:8080',
      clientId: 'app',
      clientToken: 'secret-token-1234',
      healthPath: '/health',
      nimReadinessPath: '/v1/provider/readiness',
      timeoutMs: 500,
      fetchImplementation
    });

    await expect(client.getNimReadiness()).rejects.toMatchObject({ code: 'OPENSHELL_INVALID_RESPONSE' });
  });
});
