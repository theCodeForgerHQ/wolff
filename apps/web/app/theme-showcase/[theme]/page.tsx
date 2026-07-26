'use client';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { use } from 'react';
import {
  ArrowRight,
  Check,
  FileText,
  Users,
  CreditCard,
  BarChart3,
  Bell,
  Search,
  Plus,
  MoreHorizontal,
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle2,
  XCircle,
  Send,
  Download,
  Eye,
  Sparkles,
  Database,
  Zap,
} from 'lucide-react';

// Actual Shadcn Theme configurations from official sources
const themes = {
  // Official Shadcn Blue Theme
  'default-blue': {
    name: 'Default + Blue',
    tagline: 'Official Shadcn',
    description:
      'The official shadcn/ui blue theme. Trust & reliability for professional services, financial tools, and business applications.',
    badge: 'Official',
    icon: Zap,
    heroGradient:
      'from-blue-50/80 via-slate-50 to-white dark:from-slate-950 dark:via-blue-950/20 dark:to-slate-950',
    logoGradient: 'from-blue-600 to-blue-700',
    accentColor: 'blue',
    // Light mode CSS (HSL format - official shadcn blue)
    lightCss: `
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 221.2 83.2% 53.3%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --ring: 221.2 83.2% 53.3%;
      --radius: 0.5rem;
      --chart-1: 221.2 83.2% 53.3%;
      --chart-2: 212 95% 68%;
      --chart-3: 216 92% 60%;
      --chart-4: 210 98% 78%;
      --chart-5: 212 97% 87%;
    `,
    // Dark mode CSS
    darkCss: `
      --background: 222.2 84% 4.9%;
      --foreground: 210 40% 98%;
      --card: 222.2 84% 4.9%;
      --card-foreground: 210 40% 98%;
      --popover: 222.2 84% 4.9%;
      --popover-foreground: 210 40% 98%;
      --primary: 217.2 91.2% 59.8%;
      --primary-foreground: 222.2 47.4% 11.2%;
      --secondary: 217.2 32.6% 17.5%;
      --secondary-foreground: 210 40% 98%;
      --muted: 217.2 32.6% 17.5%;
      --muted-foreground: 215 20.2% 65.1%;
      --accent: 217.2 32.6% 17.5%;
      --accent-foreground: 210 40% 98%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 210 40% 98%;
      --border: 217.2 32.6% 17.5%;
      --input: 217.2 32.6% 17.5%;
      --ring: 224.3 76.3% 48%;
      --chart-1: 221.2 83.2% 53.3%;
      --chart-2: 217.2 91.2% 59.8%;
      --chart-3: 224.3 76.3% 48%;
      --chart-4: 210 98% 78%;
      --chart-5: 212 97% 87%;
    `,
  },
  // Claude Theme - Anthropic inspired warm terracotta
  claude: {
    name: 'Claude',
    tagline: 'Anthropic Inspired',
    description:
      'Warm terracotta orange that feels human. Cream backgrounds that invite conversation. Intelligence that feels approachable.',
    badge: 'AI-Native',
    icon: Sparkles,
    heroGradient:
      'from-orange-50/80 via-amber-50/50 to-white dark:from-stone-950 dark:via-orange-950/20 dark:to-stone-950',
    logoGradient: 'from-orange-500 to-amber-600',
    accentColor: 'orange',
    // Light mode - warm terracotta with cream backgrounds
    lightCss: `
      --background: 40 33% 98%;
      --foreground: 20 14% 15%;
      --card: 40 33% 99%;
      --card-foreground: 20 14% 15%;
      --popover: 40 33% 99%;
      --popover-foreground: 20 14% 15%;
      --primary: 24 75% 50%;
      --primary-foreground: 40 33% 98%;
      --secondary: 35 30% 94%;
      --secondary-foreground: 20 14% 20%;
      --muted: 35 20% 93%;
      --muted-foreground: 20 10% 45%;
      --accent: 35 30% 92%;
      --accent-foreground: 20 14% 20%;
      --destructive: 0 84% 60%;
      --destructive-foreground: 0 0% 100%;
      --border: 30 20% 88%;
      --input: 30 20% 88%;
      --ring: 24 75% 50%;
      --radius: 0.625rem;
      --chart-1: 24 75% 50%;
      --chart-2: 35 80% 56%;
      --chart-3: 45 90% 58%;
      --chart-4: 16 70% 55%;
      --chart-5: 30 85% 60%;
    `,
    // Dark mode - evening warmth
    darkCss: `
      --background: 20 14% 10%;
      --foreground: 40 20% 94%;
      --card: 20 14% 12%;
      --card-foreground: 40 20% 94%;
      --popover: 20 14% 12%;
      --popover-foreground: 40 20% 94%;
      --primary: 24 80% 55%;
      --primary-foreground: 20 14% 10%;
      --secondary: 20 12% 18%;
      --secondary-foreground: 40 20% 94%;
      --muted: 20 12% 18%;
      --muted-foreground: 30 15% 60%;
      --accent: 20 15% 20%;
      --accent-foreground: 40 20% 94%;
      --destructive: 0 70% 45%;
      --destructive-foreground: 0 0% 100%;
      --border: 20 12% 20%;
      --input: 20 12% 20%;
      --ring: 24 80% 55%;
      --chart-1: 24 80% 55%;
      --chart-2: 35 75% 50%;
      --chart-3: 45 85% 52%;
      --chart-4: 16 65% 50%;
      --chart-5: 30 80% 55%;
    `,
  },
  // Supabase Theme - Developer-friendly emerald green
  supabase: {
    name: 'Supabase',
    tagline: 'Developer Native',
    description:
      'That distinctive green that says "database operations just work." Clean, modern aesthetics for developer tools and technical products.',
    badge: 'Dev-Friendly',
    icon: Database,
    heroGradient:
      'from-emerald-50/80 via-teal-50/30 to-white dark:from-slate-950 dark:via-emerald-950/20 dark:to-slate-950',
    logoGradient: 'from-emerald-500 to-teal-600',
    accentColor: 'emerald',
    // Light mode - clean with emerald primary
    lightCss: `
      --background: 0 0% 99%;
      --foreground: 160 10% 12%;
      --card: 0 0% 100%;
      --card-foreground: 160 10% 12%;
      --popover: 0 0% 100%;
      --popover-foreground: 160 10% 12%;
      --primary: 160 84% 39%;
      --primary-foreground: 160 10% 98%;
      --secondary: 160 15% 95%;
      --secondary-foreground: 160 10% 15%;
      --muted: 160 10% 94%;
      --muted-foreground: 160 8% 45%;
      --accent: 160 15% 93%;
      --accent-foreground: 160 10% 15%;
      --destructive: 0 84% 60%;
      --destructive-foreground: 0 0% 100%;
      --border: 160 10% 90%;
      --input: 160 10% 90%;
      --ring: 160 84% 39%;
      --radius: 0.5rem;
      --chart-1: 160 84% 39%;
      --chart-2: 168 80% 45%;
      --chart-3: 152 76% 35%;
      --chart-4: 174 72% 50%;
      --chart-5: 145 70% 42%;
    `,
    // Dark mode - comfortable for late-night coding
    darkCss: `
      --background: 160 15% 8%;
      --foreground: 160 10% 95%;
      --card: 160 15% 10%;
      --card-foreground: 160 10% 95%;
      --popover: 160 15% 10%;
      --popover-foreground: 160 10% 95%;
      --primary: 160 75% 45%;
      --primary-foreground: 160 15% 8%;
      --secondary: 160 12% 15%;
      --secondary-foreground: 160 10% 95%;
      --muted: 160 12% 15%;
      --muted-foreground: 160 10% 60%;
      --accent: 160 15% 18%;
      --accent-foreground: 160 10% 95%;
      --destructive: 0 70% 45%;
      --destructive-foreground: 0 0% 100%;
      --border: 160 12% 18%;
      --input: 160 12% 18%;
      --ring: 160 75% 45%;
      --chart-1: 160 75% 45%;
      --chart-2: 168 70% 50%;
      --chart-3: 152 65% 40%;
      --chart-4: 174 65% 55%;
      --chart-5: 145 60% 48%;
    `,
  },
} as const;

type ThemeKey = keyof typeof themes;

// Mock data
const stats = [
  { label: 'Total Revenue', value: '$124,500', change: '+12.5%', up: true, icon: CreditCard },
  { label: 'Active Quotes', value: '23', change: '+3', up: true, icon: FileText },
  { label: 'Clients', value: '48', change: '+5', up: true, icon: Users },
  { label: 'Conversion Rate', value: '68%', change: '-2%', up: false, icon: BarChart3 },
];

const recentQuotes = [
  { id: 'Q-2024-001', client: 'Acme Corp', amount: '$12,500', status: 'sent', date: '2 hours ago' },
  {
    id: 'Q-2024-002',
    client: 'TechStart Inc',
    amount: '$8,750',
    status: 'viewed',
    date: '5 hours ago',
  },
  {
    id: 'Q-2024-003',
    client: 'Design Studio',
    amount: '$3,200',
    status: 'accepted',
    date: '1 day ago',
  },
  {
    id: 'Q-2024-004',
    client: 'Global Media',
    amount: '$15,000',
    status: 'draft',
    date: '2 days ago',
  },
];

const statusConfig = {
  draft: { icon: Clock, label: 'Draft' },
  sent: { icon: Send, label: 'Sent' },
  viewed: { icon: Eye, label: 'Viewed' },
  accepted: { icon: CheckCircle2, label: 'Accepted' },
  rejected: { icon: XCircle, label: 'Rejected' },
};

export default function ThemeShowcasePage({ params }: { params: Promise<{ theme: string }> }) {
  const resolvedParams = use(params);
  const themeKey = resolvedParams.theme as ThemeKey;

  if (!themes[themeKey]) {
    notFound();
  }

  const theme = themes[themeKey];
  const otherThemes = Object.keys(themes).filter((t) => t !== themeKey) as ThemeKey[];
  const ThemeIcon = theme.icon;

  return (
    <>
      {/* Inject theme CSS variables */}
      <style jsx global>{`
        :root {
          ${theme.lightCss}
        }
        .dark {
          ${theme.darkCss}
        }
      `}</style>

      <div className={`bg-linear-to-br min-h-screen ${theme.heroGradient}`}>
        {/* Theme Switcher Banner */}
        <div className="bg-foreground text-background border-border/10 border-b py-3">
          <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 sm:flex-row">
            <div className="flex items-center gap-3">
              <span className="text-sm opacity-70">Viewing:</span>
              <span className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold">
                <ThemeIcon className="h-3.5 w-3.5" />
                {theme.name}
              </span>
              <span className="bg-background/20 text-background/80 rounded px-2 py-0.5 text-xs">
                {theme.tagline}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm opacity-70">Compare:</span>
              {otherThemes.map((t) => (
                <Link
                  key={t}
                  href={`/theme-showcase/${t}`}
                  className="bg-background/10 hover:bg-background/20 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                >
                  {themes[t].name}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Header */}
        <header className="border-border bg-background/80 backdrop-blur-xs sticky top-0 z-50 border-b">
          <div className="container mx-auto px-4">
            <div className="flex h-16 items-center justify-between">
              <div className="flex items-center gap-8">
                <Link href="/" className="flex items-center gap-2.5">
                  <div
                    className={`bg-linear-to-br h-9 w-9 rounded-lg ${theme.logoGradient} flex items-center justify-center shadow-sm`}
                  >
                    <FileText className="h-5 w-5 text-white" />
                  </div>
                  <span className="text-foreground text-xl font-bold">Wolff</span>
                </Link>
                <nav className="hidden items-center gap-1 md:flex">
                  <span className="text-primary bg-primary/10 rounded-md px-3 py-2 text-sm font-medium">
                    Dashboard
                  </span>
                  <span className="text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors">
                    Quotes
                  </span>
                  <span className="text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors">
                    Invoices
                  </span>
                  <span className="text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors">
                    Clients
                  </span>
                </nav>
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-muted border-border hidden items-center gap-2 rounded-lg border px-3 py-2 sm:flex">
                  <Search className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">Search...</span>
                  <kbd className="bg-background border-border rounded border px-1.5 py-0.5 font-mono text-xs">
                    ⌘K
                  </kbd>
                </div>
                <button className="hover:bg-muted hover:border-border relative rounded-lg border border-transparent p-2 transition-colors">
                  <Bell className="text-muted-foreground h-5 w-5" />
                  <span className="bg-primary absolute right-1.5 top-1.5 h-2 w-2 rounded-full" />
                </button>
                <div className="bg-linear-to-br from-primary to-primary/70 text-primary-foreground flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold shadow-sm">
                  JD
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="container mx-auto px-4 py-8">
          {/* Page Header */}
          <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h1 className="text-foreground text-2xl font-bold">Dashboard</h1>
              <p className="text-muted-foreground mt-1">
                Welcome back, here&apos;s your business overview.
              </p>
            </div>
            <button className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2 rounded-lg px-4 py-2.5 font-medium shadow-sm transition-colors">
              <Plus className="h-4 w-4" />
              New Quote
            </button>
          </div>

          {/* Stats Grid */}
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="bg-card border-border rounded-xl border p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div className="bg-primary/10 rounded-lg p-2.5">
                    <stat.icon className="text-primary h-5 w-5" />
                  </div>
                  <span
                    className={`flex items-center gap-1 text-sm font-medium ${stat.up ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
                  >
                    {stat.up ? (
                      <TrendingUp className="h-3.5 w-3.5" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5" />
                    )}
                    {stat.change}
                  </span>
                </div>
                <div className="text-card-foreground text-2xl font-bold">{stat.value}</div>
                <div className="text-muted-foreground mt-1 text-sm">{stat.label}</div>
              </div>
            ))}
          </div>

          {/* Content Grid */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Recent Quotes */}
            <div className="bg-card border-border rounded-xl border shadow-sm lg:col-span-2">
              <div className="border-border flex items-center justify-between border-b p-6">
                <h2 className="text-card-foreground text-lg font-semibold">Recent Quotes</h2>
                <button className="text-primary hover:text-primary/80 text-sm font-medium transition-colors">
                  View All
                </button>
              </div>
              <div className="divide-border divide-y">
                {recentQuotes.map((quote) => {
                  const status = statusConfig[quote.status as keyof typeof statusConfig];
                  return (
                    <div key={quote.id} className="hover:bg-muted/50 p-4 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
                            <status.icon className="text-muted-foreground h-5 w-5" />
                          </div>
                          <div>
                            <div className="text-card-foreground font-medium">{quote.client}</div>
                            <div className="text-muted-foreground text-sm">{quote.id}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-card-foreground font-semibold">{quote.amount}</div>
                          <div className="text-muted-foreground text-sm">{quote.date}</div>
                        </div>
                        <button className="hover:bg-muted rounded-lg p-2">
                          <MoreHorizontal className="text-muted-foreground h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Quick Actions + Revenue Chart */}
            <div className="space-y-6">
              {/* Quick Actions */}
              <div className="bg-card border-border rounded-xl border p-6 shadow-sm">
                <h2 className="text-card-foreground mb-4 text-lg font-semibold">Quick Actions</h2>
                <div className="space-y-3">
                  <button className="border-primary/30 hover:border-primary hover:bg-primary/5 text-primary flex w-full items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 transition-all">
                    <FileText className="h-5 w-5" />
                    <span className="font-medium">Create Quote</span>
                  </button>
                  <button className="border-border hover:bg-muted text-muted-foreground hover:text-foreground flex w-full items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
                    <Users className="h-5 w-5" />
                    <span className="font-medium">Add Client</span>
                  </button>
                  <button className="border-border hover:bg-muted text-muted-foreground hover:text-foreground flex w-full items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
                    <Download className="h-5 w-5" />
                    <span className="font-medium">Export Report</span>
                  </button>
                </div>
              </div>

              {/* Mini Chart */}
              <div className="bg-card border-border rounded-xl border p-6 shadow-sm">
                <h2 className="text-card-foreground mb-4 text-lg font-semibold">Revenue Trend</h2>
                <div className="flex h-32 items-end justify-between gap-2">
                  {[40, 65, 45, 80, 55, 90, 70].map((height, i) => (
                    <div key={i} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="bg-primary/80 hover:bg-primary w-full rounded-t transition-colors"
                        style={{ height: `${height}%` }}
                      />
                      <span className="text-muted-foreground text-xs">
                        {['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Feature Showcase */}
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div
              className={`bg-linear-to-br rounded-xl p-6 ${theme.logoGradient} text-white shadow-lg`}
            >
              <h3 className="mb-2 text-lg font-semibold">Visual Quote Builder</h3>
              <p className="mb-4 text-sm text-white/80">
                Drag-and-drop blocks to create stunning quotes in minutes.
              </p>
              <button className="flex items-center gap-2 rounded-lg bg-white/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/30">
                Try it now
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            <div className="bg-card border-border rounded-xl border p-6 shadow-sm">
              <div className="bg-primary/10 mb-4 flex h-10 w-10 items-center justify-center rounded-lg">
                <Check className="text-primary h-5 w-5" />
              </div>
              <h3 className="text-card-foreground mb-2 text-lg font-semibold">E-Signatures</h3>
              <p className="text-muted-foreground text-sm">
                Get quotes signed online with legally binding signatures.
              </p>
            </div>
            <div className="bg-card border-border rounded-xl border p-6 shadow-sm">
              <div className="bg-primary/10 mb-4 flex h-10 w-10 items-center justify-center rounded-lg">
                <CreditCard className="text-primary h-5 w-5" />
              </div>
              <h3 className="text-card-foreground mb-2 text-lg font-semibold">Accept Payments</h3>
              <p className="text-muted-foreground text-sm">
                Get paid faster with integrated Stripe payments.
              </p>
            </div>
          </div>

          {/* Theme Info Card */}
          <div className="bg-card border-border mt-12 rounded-2xl border p-8 shadow-sm">
            <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
              <div className="flex-1">
                <div className="mb-3 flex items-center gap-3">
                  <div className={`bg-linear-to-br rounded-lg p-2 ${theme.logoGradient}`}>
                    <ThemeIcon className="h-5 w-5 text-white" />
                  </div>
                  <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 text-xs font-semibold">
                    {theme.badge}
                  </span>
                </div>
                <h2 className="text-card-foreground mb-2 text-2xl font-bold">{theme.name} Theme</h2>
                <p className="text-muted-foreground max-w-2xl">{theme.description}</p>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  href="/"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-6 py-3 font-medium shadow-sm transition-colors"
                >
                  Use This Theme
                </Link>
              </div>
            </div>

            {/* Color Palette Preview */}
            <div className="border-border mt-8 border-t pt-6">
              <h3 className="text-muted-foreground mb-4 text-sm font-medium">Color Palette</h3>
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-primary h-12 w-12 rounded-lg shadow-sm" />
                  <span className="text-muted-foreground text-xs">Primary</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-secondary border-border h-12 w-12 rounded-lg border" />
                  <span className="text-muted-foreground text-xs">Secondary</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-muted border-border h-12 w-12 rounded-lg border" />
                  <span className="text-muted-foreground text-xs">Muted</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-accent border-border h-12 w-12 rounded-lg border" />
                  <span className="text-muted-foreground text-xs">Accent</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-background border-border h-12 w-12 rounded-lg border" />
                  <span className="text-muted-foreground text-xs">Background</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-card border-border h-12 w-12 rounded-lg border" />
                  <span className="text-muted-foreground text-xs">Card</span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-destructive h-12 w-12 rounded-lg" />
                  <span className="text-muted-foreground text-xs">Destructive</span>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-border bg-card mt-16 border-t">
          <div className="container mx-auto px-4 py-8">
            <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
              <div className="flex items-center gap-2">
                <div
                  className={`bg-linear-to-br h-7 w-7 rounded-md ${theme.logoGradient} flex items-center justify-center`}
                >
                  <FileText className="h-4 w-4 text-white" />
                </div>
                <span className="text-foreground font-semibold">Wolff</span>
              </div>
              <p className="text-muted-foreground text-sm">Theme showcase for stakeholder review</p>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
