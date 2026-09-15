export interface LivenessStatus {
  readonly status: 'ok';
}

export class GetLivenessUseCase {
  public execute(): LivenessStatus {
    return { status: 'ok' };
  }
}
