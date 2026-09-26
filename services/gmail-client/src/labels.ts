import { ContentTag, ResponseState } from "@email-concierge/shared";

/**
 * Naming convention for labels this app owns in Gmail.
 *
 * All app-owned labels live under the `Concierge/` prefix, which acts as
 * both a human-visible namespace in Gmail's label list and the allowlist
 * filter this wrapper uses to recognize "labels we created" versus
 * anything else in the user's mailbox (see refreshLabelAllowlist in
 * gmail-client.ts). Never treat a label as app-owned just because its ID
 * happens to be cached; the prefix is the source of truth for what we
 * are willing to create.
 *
 * Within the namespace we split into two sub-groups so the two taxonomy
 * dimensions (response-state, content-tag) don't collide:
 *   Concierge/Status/<ResponseState>
 *   Concierge/Tag/<ContentTag>
 *
 * Gmail treats "/" in a label name as a nesting separator (it will
 * materialize intermediate parent labels), so any "/" inside an enum
 * value itself (e.g. ContentTag's "Bulk/Marketing") is sanitized to "-"
 * to avoid accidentally creating an extra nesting level that isn't part
 * of the intended taxonomy.
 */
export const APP_LABEL_PREFIX = "Concierge/";

function sanitizeSegment(value: string): string {
  return value.replaceAll("/", "-");
}

export function responseStateLabelName(state: ResponseState): string {
  return `${APP_LABEL_PREFIX}Status/${sanitizeSegment(state)}`;
}

export function contentTagLabelName(tag: ContentTag): string {
  return `${APP_LABEL_PREFIX}Tag/${sanitizeSegment(tag)}`;
}

/**
 * Every label name the app's taxonomy is expected to need. Used to
 * create any missing labels on refreshLabelAllowlist() and to know,
 * independent of what's already in Gmail, what "the full taxonomy"
 * looks like.
 */
export function expectedTaxonomyLabelNames(): readonly string[] {
  const statusLabels = ResponseState.options.map(responseStateLabelName);
  const tagLabels = ContentTag.options.map(contentTagLabelName);
  return [...statusLabels, ...tagLabels];
}

/**
 * True if `name` falls under this app's owned namespace. This is the
 * filter applied to labels.list results to build the allowlist — it is
 * intentionally broader than expectedTaxonomyLabelNames() so that
 * labels created by a previous version of the taxonomy (e.g. after a
 * future enum value is added or renamed) are still recognized as
 * app-owned and safe to reference, rather than only ever the exact
 * current set.
 */
export function isAppOwnedLabelName(name: string): boolean {
  return name.startsWith(APP_LABEL_PREFIX);
}
