'use client';

import {
  BookOpen,
  MessageCircle,
  Mail,
  FileText,
  Video,
  ExternalLink,
  Lightbulb,
  Bug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const helpTopics = [
  {
    icon: FileText,
    title: 'Getting Started',
    description: 'Learn the basics of creating quotes and invoices',
    href: '/help#getting-started',
  },
  {
    icon: BookOpen,
    title: 'Documentation',
    description: 'Comprehensive guides and API references',
    href: '/help#docs',
  },
  {
    icon: Video,
    title: 'Video Tutorials',
    description: 'Watch step-by-step tutorials',
    href: '/help#tutorials',
  },
  {
    icon: Lightbulb,
    title: 'Tips & Tricks',
    description: 'Get the most out of Wolff',
    href: '/help#tips',
  },
];

const supportOptions = [
  {
    icon: MessageCircle,
    title: 'Live Chat',
    description: 'Chat with our support team',
    action: 'Start Chat',
    available: false,
  },
  {
    icon: Mail,
    title: 'Email Support',
    description: "We'll respond within 24 hours",
    action: 'Send Email',
    href: 'mailto:support@wolff.app',
    available: true,
  },
  {
    icon: Bug,
    title: 'Report a Bug',
    description: 'Found an issue? Let us know',
    action: 'Report Bug',
    href: 'mailto:support@wolff.app?subject=Bug%20Report',
    available: true,
  },
];

const faqs = [
  {
    question: 'How do I create my first quote?',
    answer:
      'Navigate to Quotes in the sidebar, click "New Quote", fill in the client details and line items, then save or send to your client.',
  },
  {
    question: 'Can I convert a quote to an invoice?',
    answer:
      'Yes! Once a quote is accepted, you can convert it to an invoice with one click. All the details will be automatically transferred.',
  },
  {
    question: 'How do I set up payment processing?',
    answer:
      'Go to Settings > Payments and connect your Stripe account. Once connected, your clients can pay invoices directly.',
  },
  {
    question: 'Can I customize the look of my quotes?',
    answer:
      'Yes! Go to Settings > Branding to customize colors, fonts, and add your logo to all your documents.',
  },
];

export default function HelpPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Help & Support</h1>
        <p className="text-muted-foreground">Find answers, learn best practices, and get support</p>
      </div>

      {/* Low #78: Added IDs for anchor navigation from help topic links */}
      <section id="getting-started">
        <h2 className="text-muted-foreground mb-3 text-sm font-medium">Resources</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {helpTopics.map((topic) => (
            <a
              key={topic.title}
              href={topic.href}
              className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-4 transition-colors"
            >
              <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                <topic.icon className="text-primary h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{topic.title}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{topic.description}</p>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* FAQs */}
      <section id="tips">
        <h2 className="text-muted-foreground mb-3 text-sm font-medium">
          Frequently Asked Questions
        </h2>
        <div className="rounded-lg border">
          <Accordion type="single" collapsible className="px-4">
            {faqs.map((faq, index) => (
              <AccordionItem
                key={index}
                value={`faq-${index}`}
                className={index === faqs.length - 1 ? 'border-b-0' : ''}
              >
                <AccordionTrigger className="text-sm hover:no-underline">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{faq.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Support Options */}
      <section id="docs">
        <h2 className="text-muted-foreground mb-3 text-sm font-medium">Get Support</h2>
        <div className="divide-y rounded-lg border">
          {supportOptions.map((option) => (
            <div key={option.title} className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                  <option.icon className="text-primary h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">{option.title}</p>
                  <p className="text-muted-foreground text-xs">{option.description}</p>
                </div>
              </div>
              {option.available ? (
                option.href ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={option.href} target="_blank" rel="noopener noreferrer">
                      {option.action}
                      <ExternalLink className="ml-2 h-3 w-3" />
                    </a>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm">
                    {option.action}
                  </Button>
                )
              ) : (
                <span className="text-muted-foreground text-xs">Coming soon</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
