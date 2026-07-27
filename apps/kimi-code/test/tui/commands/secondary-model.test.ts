import type { ModelAlias, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleSecondaryModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly currentThinkingEffort: string;
  readonly title?: string;
  readonly onSelect: (selection: { alias: string; thinking: ThinkingEffort }) => void;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly withSession?: boolean;
  readonly secondaryModel?: { model: string; defaultEffort?: string };
}) {
  const session = options?.withSession === false
    ? undefined
    : { setSecondaryModel: vi.fn(async () => {}) };
  const host = {
    state: {
      appState: {
        availableModels: {
          k2: model('k2'),
          cheap: model('cheap'),
          // The synthesized derived entry must never be selectable.
          '__secondary__': model('cheap'),
        },
        availableProviders: {},
        transcriptEntries: [],
      },
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        secondaryModel: options?.secondaryModel,
      })),
      setConfig: vi.fn(async () => ({ providers: {} })),
    },
    session,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host, session };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleSecondaryModelCommand', () => {
  it('opens the picker filtered to user models, with the configured recipe as current', async () => {
    const { host } = makeHost({ secondaryModel: { model: 'cheap', defaultEffort: 'high' } });

    await handleSecondaryModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.currentThinkingEffort).toBe('high');
    expect(opts.title).toContain('secondary model');
  });

  it('persists first, then live-applies the selection to the session', async () => {
    const { host, session } = makeHost();

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'high' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { model: 'k2', defaultEffort: 'high' },
    });
    expect(session!.setSecondaryModel).toHaveBeenCalledWith('k2', 'high');
    expect(host.harness.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      session!.setSecondaryModel.mock.invocationCallOrder[0]!,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('persists only when there is no session', async () => {
    const { host } = makeHost({ withSession: false });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'off' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { model: 'k2', defaultEffort: 'off' },
    });
    expect(host.showStatus.mock.calls[0]![0]).toContain('new sessions');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the synthesized derived alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '__secondary__');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: __secondary__');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleSecondaryModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });
});
