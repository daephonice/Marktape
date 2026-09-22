export type PreStocksApiRecord = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  contract_address: string;
  markPrice: number;
  markValuation: number;
  tokenPrice: number;
  impliedValuation: number;
  supply: number;
};

export type TokenRow = {
  symbol: string;
  name: string;
  description: string;
  image: string;
  externalUrl: string;
  mint: string;
  tokenPrice: number;
  markPrice: number;
  premium: number | null;
  impliedValuation: number;
  markValuation: number;
  supply: number;
  multiplier: number;
  execPrice?: number;
  divergence?: number;
};

export type Snapshot = {
  fetchedAt: string;
  tokens: TokenRow[];
};

export type Watch = {
  chatId: number;
  symbol: string;
  threshold: number;
  createdAt: string;
  lastAlertAt?: string;
  lastPremium?: number;
};
