import {
    ansi,
    c,
    setDebugLevel,
    getDebugLevel,
    log,
    type DebugLevel,
} from '../src/logger';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences from a string so we can assert on plain text. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Reset debug level before every test so tests don't bleed into each other.
beforeEach(() => setDebugLevel(false));

// ─── ansi object ────────────────────────────────────────────────────────────

describe('ansi', () => {
    it('exposes expected colour keys', () => {
        const expectedKeys = [
            'reset', 'bold', 'dim',
            'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray',
            'bgBlue', 'bgGreen', 'bgMagenta',
        ];
        expectedKeys.forEach(key => expect(ansi).toHaveProperty(key));
    });

    it('values are non-empty strings starting with ESC (\\x1b)', () => {
        Object.values(ansi).forEach(val => {
            expect(typeof val).toBe('string');
            expect(val).toMatch(/^\x1b\[/);
        });
    });
});

// ─── c() ────────────────────────────────────────────────────────────────────

describe('c()', () => {
    it('wraps text with the correct colour code and reset', () => {
        const result = c('red', 'hello');
        expect(result).toContain(ansi.red);
        expect(result).toContain('hello');
        expect(result).toContain(ansi.reset);
    });

    it('does NOT prepend bold code when bold = false (default)', () => {
        const result = c('green', 'text');
        expect(result).not.toContain(ansi.bold);
    });

    it('prepends bold code when bold = true', () => {
        const result = c('green', 'text', true);
        expect(result.startsWith(ansi.bold)).toBe(true);
        expect(result).toContain(ansi.green);
    });

    it('returns plain text surrounded by ANSI codes (strip helper sanity-check)', () => {
        expect(strip(c('cyan', 'world'))).toBe('world');
    });
});

// ─── setDebugLevel / getDebugLevel ──────────────────────────────────────────

describe('setDebugLevel / getDebugLevel', () => {
    const levels: DebugLevel[] = [false, 'error', 'info', true];

    levels.forEach(level => {
        it(`round-trips level "${level}"`, () => {
            setDebugLevel(level);
            expect(getDebugLevel()).toBe(level);
        });
    });
});

// ─── log.verbose ─────────────────────────────────────────────────────────────

describe('log.verbose()', () => {
    let consoleSpy: jest.SpyInstance;
    beforeEach(() => { consoleSpy = jest.spyOn(console, 'log').mockImplementation(); });
    afterEach(() => consoleSpy.mockRestore());

    it('does NOT log when level is false', () => {
        setDebugLevel(false);
        log.verbose('msg');
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does NOT log when level is "error"', () => {
        setDebugLevel('error');
        log.verbose('msg');
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does NOT log when level is "info"', () => {
        setDebugLevel('info');
        log.verbose('msg');
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('logs when level is true', () => {
        setDebugLevel(true);
        log.verbose('verbose message');
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const [tag, ...rest] = consoleSpy.mock.calls[0];
        expect(strip(tag)).toBe('[verbose]');
        expect(rest).toContain('verbose message');
    });

    it('forwards multiple arguments', () => {
        setDebugLevel(true);
        log.verbose('a', 'b', 42);
        expect(consoleSpy.mock.calls[0]).toEqual(
            expect.arrayContaining(['a', 'b', 42]),
        );
    });
});

// ─── log.info ────────────────────────────────────────────────────────────────

describe('log.info()', () => {
    let consoleSpy: jest.SpyInstance;
    beforeEach(() => { consoleSpy = jest.spyOn(console, 'log').mockImplementation(); });
    afterEach(() => consoleSpy.mockRestore());

    it('does NOT log when level is false', () => {
        setDebugLevel(false);
        log.info('msg');
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('does NOT log when level is "error"', () => {
        setDebugLevel('error');
        log.info('msg');
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('logs when level is "info"', () => {
        setDebugLevel('info');
        log.info('info message');
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(strip(consoleSpy.mock.calls[0][0])).toBe('[info]');
    });

    it('logs when level is true', () => {
        setDebugLevel(true);
        log.info('verbose info');
        expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
});

// ─── log.warn ────────────────────────────────────────────────────────────────

describe('log.warn()', () => {
    let warnSpy: jest.SpyInstance;
    beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(); });
    afterEach(() => warnSpy.mockRestore());

    it('does NOT warn when level is false', () => {
        setDebugLevel(false);
        log.warn('msg');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT warn when level is "error"', () => {
        setDebugLevel('error');
        log.warn('msg');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns when level is "info"', () => {
        setDebugLevel('info');
        log.warn('watch out');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(strip(warnSpy.mock.calls[0][0])).toBe('[warn]');
    });

    it('warns when level is true', () => {
        setDebugLevel(true);
        log.warn('verbose warn');
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});

// ─── log.error ───────────────────────────────────────────────────────────────

describe('log.error()', () => {
    let errorSpy: jest.SpyInstance;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(); });
    afterEach(() => errorSpy.mockRestore());

    it('does NOT log error when level is false (silent)', () => {
        setDebugLevel(false);
        log.error('boom');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs error when level is "error"', () => {
        setDebugLevel('error');
        log.error('error message');
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(strip(errorSpy.mock.calls[0][0])).toBe('[error]');
    });

    it('logs error when level is "info"', () => {
        setDebugLevel('info');
        log.error('something went wrong');
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('logs error when level is true', () => {
        setDebugLevel(true);
        log.error('verbose error');
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('forwards multiple arguments including Error objects', () => {
        setDebugLevel('error');
        const err = new Error('oops');
        log.error('prefix', err);
        expect(errorSpy.mock.calls[0]).toContain(err);
    });
});

// ─── level isolation ─────────────────────────────────────────────────────────

describe('level isolation across log methods', () => {
    it('only console.log is called for info level – no warn/error leakage', () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        setDebugLevel('info');
        log.info('hello');

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});