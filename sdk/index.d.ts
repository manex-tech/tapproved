export interface SpendingPolicy {
  owner_id: string;
  agent_id: string;
  device_public_key: number[];
  network_id: string;
  soft_limit_yocto: string;
  hard_limit_yocto: string;
  daily_limit_yocto: string;
  allowed_recipients: string[];
  paused: boolean;
  next_payment_id: string;
}

export interface PaymentRecord {
  id: string;
  agent_id: string;
  recipient_id: string;
  amount_yocto: string;
  nonce: string;
  created_at_ns: string;
  expires_at_ns: string;
  status: "pending" | "approved" | "processing" | "paid" | "failed" | "expired" | "cancelled";
  hardware_approved: boolean;
}

export interface PaymentRequestResult {
  http_status: number;
  agent_id: string;
  idempotency_key: string;
  state: "completed" | "processing" | "reserved" | "uncertain";
  replayed: boolean;
  transaction_hash: string | null;
  execution_transaction_hash: string | null;
  payment: PaymentRecord | null;
}

export interface PendingApprovalContext {
  pending: boolean;
  payment?: PaymentRecord;
  time_remaining_ms?: number;
}

export interface TransactionStatusResult {
  status: "FINAL" | "PENDING" | "UNKNOWN";
  receipts: Array<{
    receipt_id: string;
    predecessor_id: string;
    receiver_id: string;
    status: string;
  }>;
}

export interface TapprovedClientOptions {
  relayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface RequestPaymentParams {
  recipientId: string;
  amountYocto: string | bigint;
  idempotencyKey?: string | null;
}

export interface WaitForPaymentOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPendingApproval?: (payment: PaymentRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

export class TapprovedError extends Error {
  code: string;
  status: number | null;
  details: unknown;
  constructor(message: string, code: string, status?: number | null, details?: unknown);
}

export class AuthenticationError extends TapprovedError {}
export class PolicyViolationError extends TapprovedError {}
export class IdempotencyConflictError extends TapprovedError {}
export class PaymentTerminalError extends TapprovedError {
  payment: PaymentRecord;
}
export class TimeoutError extends TapprovedError {}
export class RelayConnectionError extends TapprovedError {}

export function generateIdempotencyKey(prefix?: string): string;

export class TapprovedClient {
  constructor(options: TapprovedClientOptions);
  readonly relayUrl: string;
  getHealth(options?: { signal?: AbortSignal }): Promise<{ status: string }>;
  getPolicy(options?: { signal?: AbortSignal }): Promise<SpendingPolicy>;
  getActivePayment(options?: { signal?: AbortSignal }): Promise<PaymentRecord | null>;
  getPendingApprovals(options?: { signal?: AbortSignal }): Promise<PendingApprovalContext>;
  requestPayment(params: RequestPaymentParams, options?: { signal?: AbortSignal }): Promise<PaymentRequestResult>;
  getPayment(paymentId: string | number | bigint, options?: { signal?: AbortSignal }): Promise<PaymentRecord | null>;
  getTransaction(hash: string, options?: { signal?: AbortSignal }): Promise<TransactionStatusResult>;
  waitForPaymentResolution(paymentId: string | number | bigint, options?: WaitForPaymentOptions): Promise<PaymentRecord>;
}
