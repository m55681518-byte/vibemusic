export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="vm-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#vm-grad)" />
      <path
        d="M10.2 16.9a2.1 2.1 0 1 1-1.2-1.9V8.6c0-.3.2-.5.5-.6l6-1.4c.4-.1.8.2.8.6v7.2a2.1 2.1 0 1 1-1.2-1.9v-3.7l-4.9 1.2v5.9z"
        fill="#fff"
      />
    </svg>
  );
}