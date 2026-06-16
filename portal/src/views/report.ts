import { layout, esc } from '../lib/html.js';

// User-facing "Report a bug" form. Reached from the footer link on any page.
export function renderReport(args: {
  user: string;
  isAdmin: boolean;
  sent: boolean;
}): string {
  const { user, isAdmin, sent } = args;

  const thanks = sent
    ? `<p class="banner banner-ok">Thanks — your report was sent to the admins. You can submit another below if needed.</p>`
    : '';

  const body = `
<section class="container">
  <h2>Report a bug</h2>
  <p class="lead">Found something broken or confusing in ClaudeLab? Let the admins know.</p>
  ${thanks}
  <div class="card" style="max-width:680px;">
    <form method="post" action="/api/report" class="user-form" style="flex-direction:column;align-items:stretch;gap:14px;">
      <label>
        <span>What happened?</span>
        <textarea name="message" rows="6" required maxlength="5000" autofocus
          placeholder="Describe the issue — what you did, what you expected, and what actually happened. Include the page or feature if relevant."></textarea>
      </label>
      <input type="hidden" name="page" id="report-page" value="">
      <div>
        <button class="cta">Send report</button>
      </div>
    </form>
    <p class="muted small" style="margin-top:12px;">
      Your name (<code>${esc(user)}</code>) and the page you came from are attached
      automatically so admins can follow up. Please don't include passwords or secrets.
    </p>
  </div>
</section>
<script>
  (function () {
    // Attach the page the user came from (best-effort) so admins have context.
    try {
      var el = document.getElementById('report-page');
      if (el && document.referrer) el.value = document.referrer;
    } catch (e) {}
  })();
</script>`;
  return layout('Report a bug', body, { user, isAdmin, active: 'app' });
}
