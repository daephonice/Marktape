import { formatPremium, premiumStatus } from "@marktape/core";

export default function PremiumPill({ premium, size = "md" }: { premium: number | null | undefined; size?: "sm" | "md" | "lg" }) {
  const status = premiumStatus(premium);
  const color = status === "cheap" ? "text-cheap" : status === "rich" ? "text-rich" : "text-muted";
  const sizeClass = size === "lg" ? "text-4xl" : size === "sm" ? "text-sm" : "text-lg";

  return (
    <span className={`font-mono font-semibold num-fade ${color} ${sizeClass}`}>
      {formatPremium(premium)}
    </span>
  );
}
