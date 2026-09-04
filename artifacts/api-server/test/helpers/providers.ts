export type ProviderMode =
  | "success"
  | "hard-fail"
  | "transient-fail"
  | "timeout";

export type RecordedProviderCall<TArgs extends unknown[]> = {
  sequence: number;
  args: TArgs;
};

export class MockProviderError extends Error {
  readonly provider: string;
  readonly mode: Exclude<ProviderMode, "success">;
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;

  constructor(
    provider: string,
    mode: Exclude<ProviderMode, "success">,
  ) {
    const retryable = mode !== "hard-fail";
    const code =
      mode === "timeout"
        ? "ETIMEDOUT"
        : mode === "transient-fail"
          ? "PROVIDER_TRANSIENT_FAILURE"
          : "PROVIDER_HARD_FAILURE";
    super(`${provider} mock ${mode}`);
    this.name = "MockProviderError";
    this.provider = provider;
    this.mode = mode;
    this.retryable = retryable;
    this.code = code;
    this.status = mode === "hard-fail" ? 400 : mode === "transient-fail" ? 503 : undefined;
  }
}

export type ProviderMock<TArgs extends unknown[], TResult> = {
  (...args: TArgs): Promise<TResult>;
  readonly calls: RecordedProviderCall<TArgs>[];
  readonly mode: ProviderMode;
  setMode(mode: ProviderMode): void;
  reset(): void;
};

let nextSequence = 1;

function createProviderMock<TArgs extends unknown[], TResult>(
  provider: string,
  successResult: (callNumber: number) => TResult,
): ProviderMock<TArgs, TResult> {
  let mode: ProviderMode = "success";
  const calls: RecordedProviderCall<TArgs>[] = [];

  const mock = (async (...args: TArgs): Promise<TResult> => {
    calls.push({ sequence: nextSequence++, args });
    if (mode !== "success") {
      throw new MockProviderError(provider, mode);
    }
    return successResult(calls.length);
  }) as ProviderMock<TArgs, TResult>;

  Object.defineProperties(mock, {
    calls: { get: () => calls },
    mode: { get: () => mode },
  });
  mock.setMode = (nextMode) => {
    mode = nextMode;
  };
  mock.reset = () => {
    calls.length = 0;
    mode = "success";
  };
  return mock;
}

type SmsOptions = Record<string, unknown>;
type EmailOptions = Record<string, unknown>;
type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};
type PushOptions = Record<string, unknown>;
type VoipPayload = {
  callId: string;
  callerId: string;
  callerName: string;
  callType: "video" | "audio";
};

export function createProviderMocks() {
  const sendSms = createProviderMock<
    [to: string, body: string, options?: SmsOptions],
    { success: boolean; messageId?: string; error?: string }
  >("sms", (callNumber) => ({
    success: true,
    messageId: `test-sms-${callNumber}`,
  }));

  const sendEmail = createProviderMock<
    [to: string, subject: string, body: string, options?: EmailOptions],
    { success: boolean; error?: string; dryRun?: boolean }
  >("email", () => ({ success: true }));

  const sendPush = createProviderMock<
    [userId: string, payload: PushPayload, options?: PushOptions],
    { sent: number; failed: number }
  >("push", () => ({ sent: 1, failed: 0 }));

  const sendVoip = createProviderMock<
    [token: string, platform: string, payload: VoipPayload],
    boolean
  >("voip", () => true);

  return {
    sendSms,
    sendEmail,
    sendPush,
    sendVoip,
    reset() {
      nextSequence = 1;
      sendSms.reset();
      sendEmail.reset();
      sendPush.reset();
      sendVoip.reset();
    },
  };
}
