import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-user';
const MEMBER = 'member-user';
const ROW = '22222222-2222-4222-8222-222222222222';

/** A service whose two lookups (workspace, caller's ACCEPTED row) are faked. */
function makeService(found: {
  workspace: { ownerId: string } | undefined;
  row: { id: string } | undefined;
}) {
  const workspaceFind = jest.fn().mockResolvedValue(found.workspace);
  const invitationFind = jest.fn().mockResolvedValue(found.row);
  const db = {
    query: {
      workspace: { findFirst: workspaceFind },
      workspaceInvitation: { findFirst: invitationFind },
    },
  };
  const service = new WorkspaceMembersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const removeMember = jest
    .spyOn(service, 'removeMember')
    .mockResolvedValue({ message: 'Member removed successfully' });
  return { service, removeMember, workspaceFind, invitationFind };
}

describe('WorkspaceMembersService.leaveWorkspace', () => {
  it('removes the caller own ACCEPTED row through the self-removal path', async () => {
    const { service, removeMember } = makeService({
      workspace: { ownerId: OWNER },
      row: { id: ROW },
    });
    await expect(service.leaveWorkspace(WS, MEMBER)).resolves.toBeUndefined();
    expect(removeMember).toHaveBeenCalledWith(WS, ROW, MEMBER);
  });

  it('refuses the owner with a coded 409 before it looks for a row', async () => {
    // The owner holds no invitation row, so only an owner check that runs
    // FIRST yields 409 here; a lookup-first order would answer 404.
    const { service, removeMember, invitationFind } = makeService({
      workspace: { ownerId: OWNER },
      row: undefined,
    });
    const err = await service
      .leaveWorkspace(WS, OWNER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'OWNER_CANNOT_LEAVE',
      message:
        'The owner cannot leave their own workspace. Delete the workspace instead.',
    });
    expect(invitationFind).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('is a 404 when the caller has no ACCEPTED row (pending, removed or a stranger)', async () => {
    const { service, removeMember } = makeService({
      workspace: { ownerId: OWNER },
      row: undefined,
    });
    await expect(service.leaveWorkspace(WS, MEMBER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('is a 404 when the workspace does not exist', async () => {
    const { service, removeMember } = makeService({
      workspace: undefined,
      row: undefined,
    });
    await expect(service.leaveWorkspace(WS, MEMBER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(removeMember).not.toHaveBeenCalled();
  });
});
