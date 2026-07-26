'use client';

export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="focus:bg-primary focus:text-primary-foreground focus:outline-hidden sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:px-4 focus:py-2"
    >
      Skip to main content
    </a>
  );
}
