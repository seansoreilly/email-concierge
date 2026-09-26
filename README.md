# email-concierge

Gmail email triage MVP — classifies inbound mail (Jev primary, Claude Haiku fallback), applies labels,
and drafts replies (never sent) for messages that need one. Built as an AWS solutions-architecture demo:
Terraform-provisioned Lambda + EventBridge + DynamoDB + Cognito + API Gateway + Amplify Hosting.

See `/home/sean/.claude/plans/eager-petting-cook.md` for the full build plan, phase breakdown, and
architecture rationale. Full README with ADRs and cost table lands in Phase 6.
