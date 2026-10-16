import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentWorkspaceRole } from './current-workspace-role.decorator';

class Host {
  handler(@CurrentWorkspaceRole() _role: unknown) {}
}

describe('CurrentWorkspaceRole', () => {
  it('reads req.workspaceRole', () => {
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Host, 'handler');
    const factory = Object.values<any>(meta)[0].factory;
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ workspaceRole: 'ADMIN' }),
      }),
    };
    expect(factory(undefined, ctx)).toBe('ADMIN');
  });
});
