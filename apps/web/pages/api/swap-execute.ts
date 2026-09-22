import type { NextApiRequest, NextApiResponse } from "next";

const JUPITER_EXECUTE_URL = "https://api.jup.ag/ultra/v1/execute";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const { signedTransaction, requestId } = req.body || {};
  if (!signedTransaction || !requestId) {
    return res.status(400).json({ error: "missing_params" });
  }

  const apiKey = process.env.JUPITER_API_KEY;

  try {
    const r = await fetch(JUPITER_EXECUTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction, requestId }),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 502).json(data);
  } catch {
    res.status(502).json({ error: "jupiter_unreachable" });
  }
}
