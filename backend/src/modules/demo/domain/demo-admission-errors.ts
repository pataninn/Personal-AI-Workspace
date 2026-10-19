export class DemoAdmissionError extends Error {
  public constructor(
    public readonly code: 'DEMO_ADMISSION_UNAVAILABLE' | 'DEMO_ADMISSION_RATE_LIMITED' | 'DEMO_RUN_START_RATE_LIMITED' | 'DEMO_PROVISIONING_FAILED',
    public readonly statusCode: 429 | 503,
    message: string
  ) {
    super(message);
    this.name = 'DemoAdmissionError';
  }
}

export class DemoAdmissionUnavailableError extends DemoAdmissionError {
  public constructor() {
    super('DEMO_ADMISSION_UNAVAILABLE', 503, 'Demo access is temporarily unavailable.');
  }
}

export class DemoAdmissionRateLimitedError extends DemoAdmissionError {
  public constructor() {
    super('DEMO_ADMISSION_RATE_LIMITED', 429, 'Demo access is temporarily limited. Try again later.');
  }
}

export class DemoRunStartRateLimitedError extends DemoAdmissionError {
  public constructor() {
    super('DEMO_RUN_START_RATE_LIMITED', 429, 'Demo assistant usage is temporarily limited. Try again later.');
  }
}

export class DemoProvisioningFailedError extends DemoAdmissionError {
  public constructor() {
    super('DEMO_PROVISIONING_FAILED', 503, 'Demo access could not be prepared. Try again later.');
  }
}

export class DemoAdmissionValidationError extends Error {
  public readonly code = 'VALIDATION_ERROR';
  public readonly statusCode = 400;

  public constructor() {
    super('The demo admission request is invalid.');
    this.name = 'DemoAdmissionValidationError';
  }
}
