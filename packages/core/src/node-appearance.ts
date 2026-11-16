import { z } from "zod/v3";
export const nodeAppearanceSchema = z.enum(["card", "user", "developer", "player", "client", "mobileApp", "service", "api", "database", "server", "queue", "cache", "cloud", "storage", "external", "component", "auth", "loadBalancer", "ux", "decision", "terminal"]);
export const nodeGlyphSizeSchema = z.number().finite().min(24).max(160).nullable();
export const nodeFontSizeSchema = z.number().finite().min(8).max(96);
export const nodeTitleGapSchema = z.number().finite().positive();
