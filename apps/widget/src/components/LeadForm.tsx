import { useState, useRef, type FormEvent } from 'preact/compat';
import type { WidgetConfig, LeadFormData } from '../types';
import { isBotSubmission, submitLead } from '../api';

interface LeadFormProps {
  config: WidgetConfig;
}

export function LeadForm({ config }: LeadFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startTimeRef = useRef<number>(Date.now());

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    const formData = new FormData(e.currentTarget);
    const data: LeadFormData = {
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      company: String(formData.get('company') ?? ''),
      message: String(formData.get('message') ?? ''),
      website: String(formData.get('website') ?? ''),
      _startTime: startTimeRef.current,
    };

    if (isBotSubmission(data)) {
      setError('Submission rejected.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await submitLead(config, data);
      setResult({ message: response.message ?? 'Thank you! We will be in touch soon.' });
      config.onSuccess?.(response);
      e.currentTarget.reset();
      startTimeRef.current = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setError(message);
      config.onError?.(err instanceof Error ? err : new Error(message));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="ow-widget" role="status" aria-live="polite">
        <div className="ow-success">{result.message}</div>
      </div>
    );
  }

  return (
    <form className="ow-widget" onSubmit={handleSubmit} aria-label="Contact form">
      <h2 className="ow-title">Get in touch</h2>

      <div className="ow-field">
        <label htmlFor="ow-name" className="ow-label">
          Name <span aria-label="required">*</span>
        </label>
        <input
          id="ow-name"
          name="name"
          type="text"
          className="ow-input"
          required
          autoComplete="name"
        />
      </div>

      <div className="ow-field">
        <label htmlFor="ow-email" className="ow-label">
          Email <span aria-label="required">*</span>
        </label>
        <input
          id="ow-email"
          name="email"
          type="email"
          className="ow-input"
          required
          autoComplete="email"
        />
      </div>

      <div className="ow-field">
        <label htmlFor="ow-phone" className="ow-label">
          Phone
        </label>
        <input id="ow-phone" name="phone" type="tel" className="ow-input" autoComplete="tel" />
      </div>

      <div className="ow-field">
        <label htmlFor="ow-company" className="ow-label">
          Company
        </label>
        <input
          id="ow-company"
          name="company"
          type="text"
          className="ow-input"
          autoComplete="organization"
        />
      </div>

      <div className="ow-field">
        <label htmlFor="ow-message" className="ow-label">
          Message
        </label>
        <textarea id="ow-message" name="message" className="ow-textarea" />
      </div>

      <div className="ow-field ow-honeypot" aria-hidden="true">
        <label htmlFor="ow-website">Website</label>
        <input id="ow-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <button type="submit" className="ow-button" disabled={isSubmitting}>
        {isSubmitting ? 'Sending...' : 'Send'}
      </button>

      {error && (
        <div className="ow-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
