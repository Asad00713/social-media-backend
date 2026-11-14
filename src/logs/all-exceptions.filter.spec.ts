import {
  type ArgumentsHost,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { LogWriterService } from './log-writer.service';

const TOKEN = 'Zk3v_-Q9pLmN0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';

function run(exception: unknown, url: string) {
  const write = jest.fn<void, [{ path: string | null }]>();
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter({ write } as unknown as LogWriterService).catch(
    exception,
    host,
  );
  return { write, status, json };
}

describe('AllExceptionsFilter', () => {
  it('stores the path of a failed public connect-link request without its token', () => {
    const { write } = run(
      new GoneException('gone'),
      `/public/connect-links/${TOKEN}/instagram/start`,
    );
    const entry = write.mock.calls[0][0];
    expect(entry.path).toBe('/public/connect-links/[redacted]/instagram/start');
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it('stores the Facebook Pages path without its selection id', () => {
    const SEL = 'q7Yx2LmN0aBcDeFgHiJkLmNoPqRsTuVw';
    const { write } = run(
      new GoneException('gone'),
      `/public/connect-links/${TOKEN}/facebook/pages?selection=${SEL}`,
    );
    const entry = write.mock.calls[0][0];
    expect(entry.path).toBe(
      '/public/connect-links/[redacted]/facebook/pages?selection=[redacted]',
    );
    expect(JSON.stringify(entry)).not.toContain(SEL);
  });

  it("keeps the token out of the message and stack of Nest's route-not-found 404", () => {
    // Nest's own 404 for an unknown route spells the URL in its message:
    // "Cannot POST /public/connect-links/<token>/nope"
    const url = `/public/connect-links/${TOKEN}/nope`;
    const { write, json } = run(
      new NotFoundException(`Cannot POST ${url}`),
      url,
    );
    const entry = write.mock.calls[0][0] as unknown as {
      message: string;
      stack: string | null;
    };
    expect(entry.message).toBe(
      'Cannot POST /public/connect-links/[redacted]/nope',
    );
    expect(entry.stack).toContain('/public/connect-links/[redacted]/nope');
    expect(JSON.stringify(write.mock.calls[0][0])).not.toContain(TOKEN);
    // the response is unchanged: it goes back to whoever sent the token
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: `Cannot POST ${url}` }),
    );
  });

  it('still answers with the exception, and stores ordinary paths as they are', () => {
    const { write, status, json } = run(
      new NotFoundException('nope'),
      '/workspaces/1/channels',
    );
    expect(write.mock.calls[0][0].path).toBe('/workspaces/1/channels');
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalled();
  });
});
