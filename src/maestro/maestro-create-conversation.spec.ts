import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspaceAccessService } from '../workspace-members/workspace-access.service';
import { MaestroController } from './maestro.controller';

const USER = { userId: 'user-1', email: 'u@example.test' };
const DTO = { workspaceId: 'ws-1', title: 'Plan' };

function make(role: string | null) {
  const roles = {
    getRole: jest.fn().mockResolvedValue(role),
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
  };
  const maestro = {
    createConversation: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const controller = new MaestroController(
    maestro as never,
    {} as never,
    {} as never,
    new WorkspaceAccessService(roles as never),
  );
  return { controller, maestro };
}

describe('POST /maestro/conversations by role', () => {
  it('a MEMBER starts a chat', async () => {
    const { controller, maestro } = make('MEMBER');
    await expect(controller.createConversation(USER, DTO)).resolves.toEqual({
      conversation: { id: 'c1' },
    });
    expect(maestro.createConversation).toHaveBeenCalled();
  });

  it('a Viewer is told why, not "Not found", and nothing is created', async () => {
    const { controller, maestro } = make('GUEST');
    const err = await controller.createConversation(USER, DTO).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Your role can't use Maestro in this workspace.");
    expect(maestro.createConversation).not.toHaveBeenCalled();
  });

  it('a removed member keeps the "no longer a member" copy', async () => {
    const { controller, maestro } = make(null);
    const err = await controller.createConversation(USER, DTO).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("You're no longer a member of this workspace.");
    expect(maestro.createConversation).not.toHaveBeenCalled();
  });
});
