# SSO setup — Entra ID via oauth2-proxy

This runbook gets a fresh production stack onto Entra ID single sign-on.
Allow ~30 minutes of click-ops in the Azure / Entra portals plus a few
minutes of `.env` editing on the VM. Once done, sign-in is "real" — MFA
applies, group membership controls admin access, and the basic-auth
files are gone.

## What you need before you start

| Item | Where it comes from | Lives in |
|---|---|---|
| Public FQDN | DNS A record you control | `SITE_ADDRESS` |
| Entra tenant ID | Entra → Overview → Tenant ID | `OIDC_TENANT_ID` |
| App registration Client ID | Entra → App registrations → Overview → Application (client) ID | `OIDC_CLIENT_ID` |
| Client secret | Entra → App registrations → Certificates & secrets | `OIDC_CLIENT_SECRET` |
| Admin group Object ID | Entra → Groups → Object ID | `ADMIN_GROUP_OID` |
| Cookie secret | Generated locally (see below) | `OAUTH2_PROXY_COOKIE_SECRET` |

## 1. Pick the FQDN and point DNS at the VM

`SITE_ADDRESS` and the Entra redirect URI must match. Pick once, e.g.
`claudelab.ntiva.com`. Create a DNS A record pointing at the VM's
public IP. Wait for propagation (`dig +short claudelab.ntiva.com`
should return the IP).

You **cannot** complete the Entra app registration until DNS is live —
Entra validates the redirect URI is a real `https://` URL with a valid
hostname.

## 2. Register the app in Entra

Entra Admin Center → **App registrations → New registration**.

- **Name**: `ClaudeLab` (or whatever)
- **Supported account types**: "Accounts in this organizational directory only" (single tenant)
- **Redirect URI**: Web → `https://claudelab.ntiva.com/oauth2/callback`
- Click **Register**.

Copy these from the new app's **Overview** page:

- **Application (client) ID** → `OIDC_CLIENT_ID`
- **Directory (tenant) ID** → `OIDC_TENANT_ID`

## 3. Create a client secret

App registration → **Certificates & secrets → Client secrets → New client secret**.

- Description: `oauth2-proxy`
- Expires: 24 months (set a calendar reminder to rotate)
- Click **Add**.
- **Copy the Value column immediately** — it disappears after you leave
  the page. That's `OIDC_CLIENT_SECRET`.

## 4. Configure token claims

oauth2-proxy needs the `email` claim and a `groups` claim in the ID
token. Both are off by default for new app registrations.

### Email claim

App registration → **Token configuration → Add optional claim**:

- **ID token** → check `email` → Add.
- Caddy prompts: "Microsoft Graph email permission" → accept (adds
  `email` to the app's API permissions automatically).

### Groups claim

App registration → **Token configuration → Add groups claim**:

- Check **Security groups**.
- For the token types section, check **ID** (also **Access** if you
  ever want machine-to-machine flows — not needed today).
- Customize token properties → set to **Group ID** (default).
- Save.

If your tenant has more than ~150 group memberships per user, Entra
emits a `_claim_names` overage indicator instead of a groups list and
oauth2-proxy falls back to calling Microsoft Graph. The stack still
works but you'll need to grant `GroupMember.Read.All` API permission
with admin consent. For most setups this is irrelevant — skip it.

## 5. Create the admin group (or pick an existing one)

Entra → **Groups → New group**.

- **Group type**: Security
- **Name**: `ClaudeLab — Admins`
- **Membership type**: Assigned
- Add yourself (and any other admins) as members.
- Click **Create**.

Open the new group → **Overview → Object ID** → copy. That's `ADMIN_GROUP_OID`.

## 6. Restrict who can sign in (highly recommended)

By default any user in the Entra tenant can hit the app — which means
anyone you've ever onboarded to Microsoft 365. Two layers to lock that
down:

**App-side: require assignment.** App registration → **Manage →
Enterprise applications → ClaudeLab → Properties** → set
**Assignment required?** to *Yes* → Save. Then **Users and groups** →
Add the admin group (or a dedicated "Workspace users" group).

**oauth2-proxy: email-domain allowlist.** Set
`OAUTH2_PROXY_EMAIL_DOMAINS=ntiva.com` in `.env`. Belt and braces —
even if Entra ever lets someone through, oauth2-proxy will reject
them on email-domain mismatch.

## 7. Generate the cookie secret

On the VM (or anywhere with `openssl`):

```bash
openssl rand -base64 32
```

Paste the output into `.env` as `OAUTH2_PROXY_COOKIE_SECRET`. Rotating
this invalidates every active session — fine for routine maintenance,
useful for emergency kick-everyone-out.

## 8. Fill in `.env` and bring the stack up

```bash
cp .env.example .env
nano .env   # fill in all the values from steps 1–7
docker compose pull oauth2-proxy
docker compose up -d --build
docker compose logs -f oauth2-proxy
```

Watch for `OAUTHPROXY` startup messages — it should print
`HTTP: listening on 0.0.0.0:4180` and `OIDC: discovered issuer`. Any
config error will fail to start with a clear message.

## 9. Smoke-test the flow

In a private browser window, visit `https://claudelab.ntiva.com`.

1. Redirected to `login.microsoftonline.com`, sign in.
2. Land back on `/`. Marketing page renders.
3. Click `/app`. Dashboard shows your email + tier.
4. Header shows the **Admin** tab (if you're in the admin group).
5. Open `/admin/users` — your username is in the table.
6. Click **Sign out** → redirected to `/oauth2/sign_out` → back to `/`.
   Refreshing forces a fresh Entra sign-in.

If admin tab is missing, check:

```bash
docker compose exec portal sh -c 'echo $ADMIN_GROUP_OID'
# Should match the Object ID from step 5.
```

And confirm your token actually has the groups claim:

```bash
docker compose logs caddy | grep X-Auth-Request-Groups
```

If the header is missing, your token doesn't include groups — revisit
step 4.

## Routine ops

- **Add a user**: assign them to the app in Enterprise applications.
  They sign in, click Create my workspace on `/app`, done.
- **Remove a user**: unassign from the app + delete container
  (`/admin` → Destroy). Their volume is preserved by default;
  check `wipe_volume` to remove it.
- **Promote/demote admin**: add/remove from the Entra admin group. No
  code/config change; their next page load reflects the new role.
- **Rotate cookie secret**: replace `OAUTH2_PROXY_COOKIE_SECRET` →
  `docker compose up -d oauth2-proxy`. Everyone re-authenticates.
- **Rotate client secret**: every 24 months. Generate a new one in
  Entra → update `.env` → `docker compose up -d oauth2-proxy`. Delete
  the old secret in Entra after confirming the new one works.

## Pitfalls we hit (so future-you doesn't repeat them)

- **Redirect URI mismatch** at sign-in: the URL in `.env`
  (`OAUTH2_PROXY_REDIRECT_URL`-derived from `SITE_ADDRESS`) must match
  the Entra app registration's Web redirect URI exactly. `https://`,
  hostname, port, path.
- **Cookie not set on `:80`**: oauth2-proxy hard-requires `Secure`
  cookies in production; HTTP-only deployments break the session
  cookie. SSO only works on HTTPS.
- **First admin lockout**: if you don't set `ADMIN_USERS` in `.env`
  for bootstrap, AND the Entra group claim isn't emitting yet, no
  one is admin and `/admin/*` 403s. Always set at least one bootstrap
  email in `ADMIN_USERS`.
- **Workspace name and email mismatch**: the slug is the lowercase
  local-part of the email. If you change someone's email in Entra,
  the slug changes too, and they get a brand-new (empty) workspace.
  Re-mapping is manual — `docker volume` rename + restart.
