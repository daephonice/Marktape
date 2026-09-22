import type { NextApiRequest, NextApiResponse } from "next";
import { isBlockedMint } from "@marktape/core";

const JUPITER_ULTRA_URL = "https://api.jup.ag/ultra/v1/order";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { inputMint, outputMint, amount, taker } = req.query as Record<string, string>;

  if (!inputMint || !outputMint || !amount || !taker) {
    return res.status(400).json({ error: "missing_params" });
  }
  if (isBlockedMint(inputMint) || isBlockedMint(outputMint)) {
    return res.status(400).json({ error: "blocked_mint" });
  }

  const apiKey = process.env.JUPITER_API_KEY;
  const url = `${JUPITER_ULTRA_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&taker=${taker}`;

  try {
    const r = await fetch(url, { headers: apiKey ? { "x-api-key": apiKey } : {} });
    const data = await r.json();
    if (!r.ok || !data.transaction) {
      return res.status(200).json({ error: "no_route", detail: data });
    }
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ error: "jupiter_unreachable" });
  }
}
