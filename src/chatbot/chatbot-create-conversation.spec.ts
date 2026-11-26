import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspaceAccessService } from '../workspace-members/workspace-access.service';
import { ChatbotController } from './chatbot.controller';

const USER = { userId: 'user-1', email: 'u@example.test' };
const DTO = { workspaceId: 'ws-1', title: 'Plan' };

function make(role: string | null) {
  const roles = {
    getRole: jest.fn().mockResolvedValue(role),
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
  };
  const chatbot = {
    createConversation: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const controller = new ChatbotController(
    chatbot as never,
    {} as never,
    {} as never,
    {} as never,
    new WorkspaceAccessService(roles as never),
  );
  return { controller, chatbot };
}

describe('POST /chatbot/conversations by role', () => {
  it('a MEMBER starts a chat', async () => {
    const { controller, chatbot } = make('MEMBER');
    await expect(controller.createConversation(USER, DTO)).resolves.toEqual({
      conversation: { id: 'c1' },
    });
    expect(chatbot.createConversation).toHaveBeenCalled();
  });

  it('a Viewer is told why, not "Not found", and nothing is created', async () => {
    const { controller, chatbot } = make('GUEST');
    const err = await controller.createConversation(USER, DTO).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(
      'Your role in this workspace does not allow this action. Ask a workspace admin to change your role.',
    );
    expect(chatbot.createConversation).not.toHaveBeenCalled();
  });

  it('a removed member keeps the "no longer a member" copy', async () => {
    const { controller, chatbot } = make(null);
    const err = await controller.createConversation(USER, DTO).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("You're no longer a member of this workspace.");
    expect(chatbot.createConversation).not.toHaveBeenCalled();
  });
});
