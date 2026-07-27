/**
 * Session-level agent profile catalog.
 *
 * Merges the builtin (code-embedded) profiles with the file-backed sources
 * (user / extra / project / explicit) by priority, requiring an explicit
 * opt-in (`override: true`) before a file replaces a same-name builtin. The
 * merged view always contains the builtin profiles (seeded at construction);
 * file profiles appear once `ready` resolves. A failing `explicit` source (an
 * invalid `--agent-file`) rejects `ready` so session creation surfaces the
 * error; a failing directory source degrades to warnings, so directory
 * problems never poison the session.
 *
 * After merging, the catalog links the delegation graph: a file profile's
 * `subagents` allowlist resolves against the merged set (an omitted allowlist
 * means "any type"), and the builtin default profile's subagent set extends
 * with every file-defined profile so the main agent can delegate to custom
 * agents.
 */

import { DEFAULT_AGENT_PROFILES } from '../default';
import type { ResolvedAgentProfile } from '../types';

import { discoverAgentFiles } from './discovery';
import { agentProfileFromFile } from './from-file';
import { resolveAgentPath } from './paths';
import { configuredAgentRoots, projectAgentRoots, userAgentRoots } from './roots';
import { loadSystemMdDefinition, systemMdProfile } from './system-file';
import { describeInactiveToolPattern, findInactiveToolPatterns } from './validate';
import type { AgentFileDefinition, AgentFileSource } from './types';
import { promises as fs } from 'node:fs';
import { parseAgentFileText } from './parser';

export interface SessionAgentCatalogOptions {
  readonly workDir: string;
  /** Brand data dir (`KIMI_CODE_HOME`, default `~/.kimi-code`). */
  readonly brandHomeDir: string;
  /** OS home dir, for `~/.agents/agents` and `~` expansion. */
  readonly osHomeDir: string;
  readonly extraDirs?: readonly string[];
  readonly explicitFiles?: readonly string[];
  readonly warn?: (message: string, error?: unknown) => void;
}

const SOURCE_PRIORITY: Readonly<Record<AgentFileSource, number>> = {
  user: 10,
  extra: 20,
  project: 30,
  explicit: 40,
};

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

/** Exact tool names known to the builtin profiles (MCP glob entries excluded). */
const KNOWN_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_AGENT_PROFILES).flatMap((profile) =>
    profile.tools.filter((tool) => !tool.startsWith('mcp__')),
  ),
);

function isKnownBuiltinToolName(name: string): boolean {
  return KNOWN_BUILTIN_TOOL_NAMES.has(name);
}

interface FileProfileEntry {
  readonly definition: AgentFileDefinition;
  readonly profile: ResolvedAgentProfile;
  readonly priority: number;
  readonly override: boolean;
}

export class SessionAgentProfileCatalog {
  private merged: Map<string, ResolvedAgentProfile>;
  private readonly readyPromise: Promise<void>;

  constructor(private readonly options: SessionAgentCatalogOptions) {
    this.merged = new Map(Object.entries(DEFAULT_AGENT_PROFILES));
    this.readyPromise = this.load();
    // Keep an un-awaited rejection from crashing the process; createMain /
    // spawn awaiters see the error through `ready`.
    void this.readyPromise.catch(() => undefined);
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get(name: string): ResolvedAgentProfile | undefined {
    return this.merged.get(name);
  }

  getDefault(): ResolvedAgentProfile {
    const profile = this.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new Error(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly ResolvedAgentProfile[] {
    return [...this.merged.values()];
  }

  /**
   * The subagent types `callerProfileName` may delegate to: the caller's own
   * linked set, falling back to the default profile's set when the caller
   * declares none (mirroring the historical lookup against the builtin
   * `agent` profile).
   */
  delegatableSubagents(callerProfileName?: string): Record<string, ResolvedAgentProfile> {
    const caller = callerProfileName === undefined ? undefined : this.merged.get(callerProfileName);
    const record = caller?.subagents ?? this.getDefault().subagents;
    return record ?? {};
  }

  private async load(): Promise<void> {
    const warn = this.warn;
    const entries: FileProfileEntry[] = [];

    // ── Directory sources (non-fatal) ────────────────────────────────
    // Each source scans its own roots: a same-named file in a higher-
    // priority source must shadow, not swallow, the lower-priority one.
    const [userRoots, projectRoots, extraRoots] = await Promise.all([
      userAgentRoots(this.options.brandHomeDir, this.options.osHomeDir, warn),
      projectAgentRoots(this.options.workDir, warn),
      configuredAgentRoots(
        this.options.extraDirs ?? [],
        this.options.workDir,
        this.options.osHomeDir,
        'extra',
        warn,
      ),
    ]);

    // SYSTEM.md is pushed first: within the user source it wins the `agent`
    // name over directory files (first candidate per priority wins).
    const systemMd = await loadSystemMdDefinition(this.options.brandHomeDir, (message) =>
      warn?.(message),
    );

    // The base every file profile's `${base_prompt}` renders against — the
    // "effective default": the SYSTEM.md override when present, else the
    // builtin default. This slot is structurally disjoint from the merge
    // (only ever SYSTEM.md or builtin), so a file profile that overrides the
    // default can never recurse into itself through `${base_prompt}`. The
    // chain is at most: agent file → SYSTEM.md → builtin default.
    const builtinDefault = this.merged.get(DEFAULT_AGENT_PROFILE_NAME) ?? this.getDefault();
    const effectiveDefault =
      systemMd !== undefined ? systemMdProfile(systemMd, builtinDefault) : builtinDefault;

    if (systemMd !== undefined) {
      entries.push(this.systemMdEntry(systemMd, effectiveDefault));
    }

    for (const roots of [userRoots, extraRoots, projectRoots]) {
      if (roots.length === 0) continue;
      const discovered = await discoverAgentFiles(roots, warn);
      for (const definition of discovered.agents) {
        this.warnInactivePatterns(definition);
        entries.push(this.entryFromDefinition(definition, effectiveDefault));
      }
    }

    // ── Explicit source (fatal) ──────────────────────────────────────
    for (const file of this.options.explicitFiles ?? []) {
      const path = resolveAgentPath(file, this.options.workDir, this.options.osHomeDir);
      const text = await fs.readFile(path, 'utf-8');
      const definition = parseAgentFileText({ path, source: 'explicit', text });
      this.warnInactivePatterns(definition);
      entries.push(this.entryFromDefinition(definition, effectiveDefault));
    }

    this.applyFileEntries(entries);
  }

  /**
   * Surface dead tool patterns (bare wildcards, incomplete `mcp__` literals,
   * unknown tool names) at load time, so a typo in a hand-written agent file
   * warns instead of silently shrinking the profile's tool set.
   */
  private warnInactivePatterns(definition: AgentFileDefinition): void {
    const warn = this.warn;
    if (warn === undefined) return;
    const fields: readonly (readonly [string, readonly string[] | undefined])[] = [
      ['tools', definition.tools],
      ['disallowedTools', definition.disallowedTools],
    ];
    for (const [field, patterns] of fields) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, isKnownBuiltinToolName)) {
        warn(`agent file ${definition.path}: ${field} entry ${describeInactiveToolPattern(issue)}`);
      }
    }
  }

  private systemMdEntry(
    definition: AgentFileDefinition,
    effectiveDefault: ResolvedAgentProfile,
  ): FileProfileEntry {
    return {
      definition,
      profile: effectiveDefault,
      priority: SOURCE_PRIORITY['user'],
      // SYSTEM.md permanently replaces the builtin default prompt.
      override: true,
    };
  }

  private entryFromDefinition(
    definition: AgentFileDefinition,
    effectiveDefault: ResolvedAgentProfile,
  ): FileProfileEntry {
    return {
      definition,
      profile: agentProfileFromFile(definition, effectiveDefault.tools, (context) =>
        effectiveDefault.systemPrompt(context),
      ),
      priority: SOURCE_PRIORITY[definition.source],
      override: definition.override || definition.source === 'explicit',
    };
  }

  private applyFileEntries(entries: readonly FileProfileEntry[]): void {
    const warn = this.warn;
    const merged = new Map(this.merged);
    const byName = new Map<string, FileProfileEntry[]>();
    for (const entry of [...entries].toSorted((a, b) => b.priority - a.priority)) {
      const candidates = byName.get(entry.definition.name) ?? [];
      candidates.push(entry);
      byName.set(entry.definition.name, candidates);
    }
    const winners: FileProfileEntry[] = [];
    for (const candidates of byName.values()) {
      for (const candidate of candidates) {
        if (merged.has(candidate.definition.name) && !candidate.override) {
          warn?.(
            `agent file profile "${candidate.definition.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
          );
          continue;
        }
        merged.set(candidate.definition.name, candidate.profile);
        winners.push(candidate);
        break;
      }
    }

    // Link the file profiles' delegation allowlists against the merged set.
    for (const winner of winners) {
      winner.profile.subagents = this.linkSubagentAllowlist(winner.definition, merged, warn);
    }

    // Extend the builtin default's delegation set with every file-defined
    // profile so the main agent can delegate to custom agents. (A file
    // profile that replaced the default carries its own allowlist instead.)
    const defaultIsBuiltin = !winners.some(
      (winner) => winner.definition.name === DEFAULT_AGENT_PROFILE_NAME,
    );
    if (defaultIsBuiltin && winners.length > 0) {
      const builtinDefault = this.getDefault();
      const fileRecord: Record<string, ResolvedAgentProfile> = {};
      for (const winner of winners) fileRecord[winner.definition.name] = winner.profile;
      merged.set(DEFAULT_AGENT_PROFILE_NAME, {
        ...builtinDefault,
        subagents: { ...builtinDefault.subagents, ...fileRecord },
      });
    }

    this.merged = merged;
  }

  private linkSubagentAllowlist(
    definition: AgentFileDefinition,
    merged: ReadonlyMap<string, ResolvedAgentProfile>,
    warn: ((message: string, error?: unknown) => void) | undefined,
  ): Record<string, ResolvedAgentProfile> {
    // An omitted allowlist means "any type"; a lone `*` was already
    // normalized away by the parser.
    const names = definition.subagents ?? [...merged.keys()];
    const record: Record<string, ResolvedAgentProfile> = {};
    for (const name of names) {
      const target = merged.get(name);
      if (target === undefined) {
        warn?.(
          `agent file profile "${definition.name}" declares subagent "${name}" but that agent profile was not found`,
        );
        continue;
      }
      record[name] = target;
    }
    return record;
  }

  private get warn(): ((message: string, error?: unknown) => void) | undefined {
    return this.options.warn;
  }
}
