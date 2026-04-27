import { z } from "zod";

// DNS-1123 label. K8s namespaces and most resource names follow this.
export const namespaceSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    "Namespace must be a valid DNS-1123 label (lowercase alphanumerics and '-').",
  );

// Broader than DNS-1123: kubectl describe accepts PVCs and other names with dots.
export const resourceNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9]([-A-Za-z0-9._]*[A-Za-z0-9])?$/,
    "Resource name must contain only letters, digits, '.', '-', '_'.",
  );

// kubectl --since: 5s, 2m, 3h, 1d.
export const sinceSchema = z
  .string()
  .regex(/^\d+[smhd]$/i, "Must be a duration like 5s, 2m, 3h, or 1d.");

// Resource kind: pod, deployment, persistentvolumeclaim, etc.
export const kindSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z][A-Za-z0-9.-]*$/,
    "Kind must look like a Kubernetes resource kind.",
  );
