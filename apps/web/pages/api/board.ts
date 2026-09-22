import type { NextApiRequest, NextApiResponse } from "next";
import { getSnapshot } from "../../snapshot";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { snapshot, stale } = await getSnapshot();
    res.status(200).json({ ...snapshot, stale });
  } catch (err) {
    res.status(503).json({ error: "upstream_unavailable", message: (err as Error).message });
  }
}
