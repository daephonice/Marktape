import { ImageResponse } from "@vercel/og";
import { formatPremium, premiumStatus } from "@marktape/core";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "").toUpperCase();

  const webUrl = process.env.NEXT_PUBLIC_WEB_URL || "";
  let token: any = null;
  try {
    const r = await fetch(`${webUrl}/api/board`);
    const data = await r.json();
    token = data.tokens?.find((t: any) => t.symbol === symbol) || null;
  } catch {
    token = null;
  }

  const premiumText = token ? formatPremium(token.premium) : "—";
  const status = token ? premiumStatus(token.premium) : "flat";
  const color = status === "cheap" ? "#3DDC97" : status === "rich" ? "#FF5C7A" : "#8B95A4";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0B0D10",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "#E8EDF2",
          fontFamily: "monospace",
        }}
      >
        <div style={{ fontSize: 96, fontWeight: 700 }}>{symbol}</div>
        <div style={{ fontSize: 56, color, marginTop: 16 }}>{premiumText} vs mark</div>
        {token && (
          <div style={{ fontSize: 32, color: "#8B95A4", marginTop: 24 }}>
            ${token.tokenPrice.toFixed(2)} tape · ${token.markPrice.toFixed(2)} mark
          </div>
        )}
        <div style={{ position: "absolute", bottom: 40, left: 48, fontSize: 24, color: "#C8F542" }}>
          MARKTAPE
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
