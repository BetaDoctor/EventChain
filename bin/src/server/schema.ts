import { Data } from "@lucid-evolution/lucid";

// ── Mirrors event_chain.ak types exactly ─────────────────────────────────────

const SideSchema = Data.Enum([
  Data.Literal("Yes"),
  Data.Literal("No"),
]);
export type Side = Data.Static<typeof SideSchema>;
export const SideSchema_ = SideSchema as unknown as Side;

// VKHs are Blake2b-224 — exactly 28 bytes. Constrain the schema so a
// malformed bet datum with a 0- or 64-byte "vkh" can't even parse (audit
// P1-C3).
const VkhSchema = Data.Bytes({ minLength: 28, maxLength: 28 });

const BetDatumSchema = Data.Object({
  market_id: Data.Bytes(),
  bettor: VkhSchema,
  side: SideSchema,
  ect_amount: Data.Integer(),
  // Refund deadline (POSIX ms).
  deadline: Data.Integer(),
});
export type BetDatum = Data.Static<typeof BetDatumSchema>;
export const BetDatumSchema_ = BetDatumSchema as unknown as BetDatum;

const ResolutionDatumSchema = Data.Object({
  market_id: Data.Bytes(),
  winner: SideSchema,
  oracle: VkhSchema,
  total_yes: Data.Integer(),
  total_no: Data.Integer(),
});
export type ResolutionDatum = Data.Static<typeof ResolutionDatumSchema>;
export const ResolutionDatumSchema_ =
  ResolutionDatumSchema as unknown as ResolutionDatum;

// OutputReference mirrors cardano/transaction.OutputReference exactly:
//   { transaction_id: ByteArray, output_index: Int }
// Tx hashes are 32 bytes on Cardano.
const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes({ minLength: 32, maxLength: 32 }),
  output_index: Data.Integer(),
});
export type OutputReference = Data.Static<typeof OutputReferenceSchema>;
export const OutputReferenceSchema_ =
  OutputReferenceSchema as unknown as OutputReference;

const PayoutDatumSchema = Data.Object({
  market_id: Data.Bytes(),
  bettor: VkhSchema,
  payout_amount: Data.Integer(),
  // Binds this payout 1:1 to its source Bet UTxO (audit P0-C2).
  bet_ref: OutputReferenceSchema,
});
export type PayoutDatum = Data.Static<typeof PayoutDatumSchema>;
export const PayoutDatumSchema_ = PayoutDatumSchema as unknown as PayoutDatum;

// EventDatum = Bet(BetDatum) | Resolution(ResolutionDatum) | Payout(PayoutDatum)
// Order must match Aiken declaration for correct constr tags.
export const EventDatumSchema = Data.Enum([
  Data.Object({ Bet: Data.Tuple([BetDatumSchema]) }),
  Data.Object({ Resolution: Data.Tuple([ResolutionDatumSchema]) }),
  Data.Object({ Payout: Data.Tuple([PayoutDatumSchema]) }),
]);
export type EventDatum = Data.Static<typeof EventDatumSchema>;
export const EventDatumSchema_ = EventDatumSchema as unknown as EventDatum;

// EventRedeemer = Resolve | Claim | Refund | ForceRefund (all no-arg).
// Order must match Aiken declaration for correct constr tags.
export const EventRedeemerSchema = Data.Enum([
  Data.Literal("Resolve"),
  Data.Literal("Claim"),
  Data.Literal("Refund"),
  Data.Literal("ForceRefund"),
]);
export type EventRedeemer = Data.Static<typeof EventRedeemerSchema>;
export const EventRedeemerSchema_ =
  EventRedeemerSchema as unknown as EventRedeemer;
