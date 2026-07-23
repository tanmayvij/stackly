export type TransactionType = "DEBIT" | "CREDIT";

export interface WalletTransaction {
  type: TransactionType;
  // CREDIT: positive; DEBIT: negative.
  valueInCents: number;
  // Always 0 for CREDIT transactions.
  tokensUsed: number;
  // CREDIT: Stripe PaymentIntent id; DEBIT: API request id.
  refId: string;
  timestamp: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  // Running balance in cents immediately after this transaction (audit trail).
  balanceAfter: number;
}

export interface AddTransactionInput {
  userId: string;
  type: TransactionType;
  valueInCents: number;
  tokensUsed: number;
  refId: string;
}
