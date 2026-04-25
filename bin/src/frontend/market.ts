export interface Market {
  id: string;
  title: string;
  category: string;
  yesPrice: number; // 0–1 in $ECT$
  noPrice: number;
  volume: number;
  endDate: string;
}

export type Side = "YES" | "NO";

export async function loadMarkets(): Promise<Market[]> {
  const res = await fetch("/api/markets");
  if (!res.ok) throw new Error("Failed to load markets");
  return res.json();
}

export async function loadMarket(id: string): Promise<Market> {
  const res = await fetch(`/api/markets/${id}`);
  if (!res.ok) throw new Error("Market not found");
  return res.json();
}

export function calculateCost(price: number, shares: number): number {
  return parseFloat((price * shares).toFixed(6));
}

export function calculatePotentialReturn(shares: number): number {
  // Winning shares pay 1.00 $ECT$ each
  return shares;
}

export function calculateImpliedProbability(price: number): number {
  return Math.round(price * 100);
}

export async function buyShares(
  market: Market,
  side: Side,
  shares: number
): Promise<void> {
  const price = side === "YES" ? market.yesPrice : market.noPrice;
  const cost = calculateCost(price, shares);

  console.log(
    `[EventChain TX] BUY ${shares} ${side} shares on "${market.title}"`,
    `| Price: ${price} $ECT$ | Total Cost: ${cost} $ECT$`
  );

  // TODO: build and submit Cardano transaction via Lucid Evolution
  // const lucid = getLucid();
  // const tx = await lucid.newTx()
  //   .payToContract(MARKET_VALIDATOR_ADDRESS, { inline: datum }, { [ECT_ASSET]: cost })
  //   .complete();
  // const signed = await tx.sign().complete();
  // await signed.submit();

  alert(
    `[Simulated] Buying ${shares} ${side} shares for ${cost} $ECT$.\n` +
      `Potential return: ${calculatePotentialReturn(shares)} $ECT$ if correct.`
  );
}
