import { z } from "zod";

// Reusable parameter schemas. Tighter than plain `z.string()` so malformed
// input is rejected at the SDK boundary with a clear message instead of
// reaching kubectl.

// DNS-1123 label. K8s namespaces and most resource names follow this.
export const namespaceSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    "Namespace must be a valid DNS-1123 label (lowercase alphanumerics and '-').",
  );

// Container/pod names: DNS-1123 label too, but allow the broader resource-name
// charset since `kubectl describe <kind> <name>` accepts e.g. PVCs with dots.
export const resourceNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9]([-A-Za-z0-9._]*[A-Za-z0-9])?$/,
    "Resource name must contain only letters, digits, '.', '-', '_'.",
  );

// kubectl --since duration: e.g. 5s, 2m, 3h, 1d. Reject anything else early.
export const sinceSchema = z
  .string()
  .regex(/^\d+[smhd]$/i, "Must be a duration like 5s, 2m, 3h, or 1d.");

// Resource kind, e.g. "pod", "deployment", "persistentvolumeclaim".
export const kindSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z][A-Za-z0-9.-]*$/,
    "Kind must look like a Kubernetes resource kind.",
  );
