// The site's logo (a radar over the sea, the same mark as industry/brand/logo.svg) and a small ring
// mark used as the loader.

/** Radar sweep over waves; the amber dot is a signal it picked up. */
export function RadarMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <g fill="none" strokeWidth="3.6" strokeLinecap="round">
        <path d="M6 29A18 18 0 0 1 42 29" stroke="currentColor" />
        <path d="M14 29A10 10 0 0 1 34 29" className="stroke-accent" />
        <path d="M5 38.5q4.75-4 9.5 0t9.5 0t9.5 0t9.5 0" className="stroke-accent" />
      </g>
      <circle cx="24" cy="29" r="3.2" className="fill-accent" />
      <circle cx="36.5" cy="14.5" r="4" className="fill-[#e0a43c] dark:fill-[#ffb547]" />
    </svg>
  );
}

/** The mark beside the English logotype "ShipRadar"; the Chinese site name stays in titles, RSS and the rest. */
export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.35em] font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: size }} aria-label="ShipRadar" role="img">
      <RadarMark className="size-[1.6em] shrink-0" />
      <span aria-hidden="true" className="whitespace-nowrap">
        Ship<span className="text-accent">Radar</span>
      </span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
