import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./pages/**/*.{ts,tsx}", "./*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0B0D10",
        surface: "#12151A",
        line: "#1E232B",
        text: "#E8EDF2",
        muted: "#8B95A4",
        cheap: "#3DDC97",
        rich: "#FF5C7A",
        accent: "#C8F542",
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "Geist Mono", "ui-monospace", "monospace"],
        sans: ["Geist", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
