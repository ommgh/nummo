/**
 * Outgoing email for accounts (password resets).
 *
 * Pick one transport with environment variables:
 *
 *   RESEND_API_KEY=re_...                      Resend's HTTP API (needs a verified domain)
 *   SMTP_URL=smtps://user:pass@host:465        any SMTP server: Brevo, Gmail, Amazon SES, Postmark...
 *   MAIL_FROM="nummo <no-reply@example.com>"   sender address, required with either
 *
 * With neither, nothing is sent. Outside production the message is printed to
 * the console instead, so the reset link can be copied during development; in
 * production a warning is logged without the link.
 */

import { createTransport } from "nodemailer";

export type Mail = { to: string; subject: string; text: string; html: string };
export type Mailer = { readonly kind: "resend" | "smtp" | "console" | "none"; send(mail: Mail): Promise<void> };

export function createMailer(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  const from = env.MAIL_FROM?.trim();
  if (env.RESEND_API_KEY) {
    if (!from) throw new Error("MAIL_FROM is required with RESEND_API_KEY");
    const key = env.RESEND_API_KEY;
    return {
      kind: "resend",
      async send(mail) {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Resend refused the email: ${res.status} ${(await res.text()).slice(0, 300)}`);
      },
    };
  }
  if (env.SMTP_URL) {
    if (!from) throw new Error("MAIL_FROM is required with SMTP_URL");
    const transport = createTransport(env.SMTP_URL);
    return {
      kind: "smtp",
      async send(mail) {
        await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
      },
    };
  }
  if (env.NODE_ENV !== "production") {
    return {
      kind: "console",
      async send(mail) {
        console.log(`[mail] no RESEND_API_KEY or SMTP_URL set; would send to ${mail.to}: ${mail.subject}\n${mail.text}`);
      },
    };
  }
  return {
    kind: "none",
    async send(mail) {
      console.warn(`[mail] email is not configured (set RESEND_API_KEY or SMTP_URL, and MAIL_FROM); dropped "${mail.subject}" to ${mail.to}`);
    },
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain message with one button. Inline styles only, since mail clients drop stylesheets. */
function layout(p: { heading: string; lines: string[]; action: string; url: string; footer: string }): string {
  const para = (t: string) => `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#3f3f46">${escape(t)}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:32px">
<p style="margin:0 0 24px;font-family:Menlo,Consolas,monospace;font-size:16px;font-weight:700;color:#09090b">nummo</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#09090b">${escape(p.heading)}</h1>
${p.lines.map(para).join("\n")}
<p style="margin:24px 0"><a href="${escape(p.url)}" style="display:inline-block;padding:10px 18px;background:#09090b;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">${escape(p.action)}</a></p>
<p style="margin:0 0 8px;font-size:12px;line-height:18px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(p.url)}</span></p>
<p style="margin:16px 0 0;font-size:12px;line-height:18px;color:#71717a">${escape(p.footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function passwordResetMail(p: { to: string; name?: string | null; url: string }): Mail {
  const hello = p.name ? `Hi ${p.name},` : "Hi,";
  const body = "Someone asked to reset the password for your nummo account. The link below works once, for one hour.";
  const footer = "If you did not ask for this, ignore this email: your password stays the same.";
  return {
    to: p.to,
    subject: "Reset your nummo password",
    text: `${hello}\n\n${body}\n\n${p.url}\n\n${footer}\n`,
    html: layout({ heading: "Reset your password", lines: [hello, body], action: "Choose a new password", url: p.url, footer }),
  };
}
