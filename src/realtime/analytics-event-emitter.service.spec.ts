import { Logger } from '@nestjs/common';
import { AnalyticsEventEmitter } from './analytics-event-emitter.service';

describe('AnalyticsEventEmitter.removeUserFromWorkspace', () => {
  afterEach(() => jest.restoreAllMocks());

  it('hands the user and workspace to the gateway', () => {
    const gateway = { removeUserFromWorkspace: jest.fn() };
    new AnalyticsEventEmitter(gateway as never).removeUserFromWorkspace(
      'u1',
      'ws1',
    );
    expect(gateway.removeUserFromWorkspace).toHaveBeenCalledWith('u1', 'ws1');
  });

  it('never throws: a gateway failure is logged as a warning', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const gateway = {
      removeUserFromWorkspace: jest.fn(() => {
        throw new Error('socket.io down');
      }),
    };

    expect(() =>
      new AnalyticsEventEmitter(gateway as never).removeUserFromWorkspace(
        'u1',
        'ws1',
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('u1'));
  });
});
