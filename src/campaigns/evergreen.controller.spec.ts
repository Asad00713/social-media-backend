import { EvergreenController } from './evergreen.controller';
import type {
  CreateEvergreenCampaignDto,
  CreateEvergreenCategoryDto,
  UpdateEvergreenCategoryDto,
  SetCategoryActiveDto,
  CreateEvergreenPostDto,
  UpdateEvergreenPostDto,
} from './dto/evergreen.dto';

describe('EvergreenController', () => {
  const workspaceId = 'ws-1';
  const campaignId = 'campaign-1';
  const categoryId = 'category-1';
  const postId = 'post-1';
  const user = { userId: 'user-1', email: 'user@example.com' };

  let mockService: {
    createCampaign: jest.Mock;
    addCategory: jest.Mock;
    updateCategory: jest.Mock;
    setCategoryActive: jest.Mock;
    removeCategory: jest.Mock;
    addPost: jest.Mock;
    updatePost: jest.Mock;
    removePost: jest.Mock;
  };
  let controller: EvergreenController;

  beforeEach(() => {
    mockService = {
      createCampaign: jest.fn().mockResolvedValue({ id: campaignId }),
      addCategory: jest.fn().mockResolvedValue({ id: campaignId }),
      updateCategory: jest.fn().mockResolvedValue({ id: campaignId }),
      setCategoryActive: jest.fn().mockResolvedValue({ id: campaignId }),
      removeCategory: jest.fn().mockResolvedValue({ id: campaignId }),
      addPost: jest.fn().mockResolvedValue({ id: campaignId }),
      updatePost: jest.fn().mockResolvedValue({ id: campaignId }),
      removePost: jest.fn().mockResolvedValue({ id: campaignId }),
    };
    controller = new EvergreenController(mockService as any);
  });

  it('createCampaign delegates to service.createCampaign(workspaceId, userId, dto)', async () => {
    const dto = { name: 'Evergreen' } as CreateEvergreenCampaignDto;
    const result = await controller.createCampaign(workspaceId, user, dto);
    expect(mockService.createCampaign).toHaveBeenCalledWith(workspaceId, user.userId, dto);
    expect(result).toEqual({ id: campaignId });
  });

  it('addCategory delegates to service.addCategory(workspaceId, campaignId, dto)', async () => {
    const dto = { name: 'Tips' } as CreateEvergreenCategoryDto;
    await controller.addCategory(workspaceId, campaignId, dto);
    expect(mockService.addCategory).toHaveBeenCalledWith(workspaceId, campaignId, dto);
  });

  it('updateCategory delegates to service.updateCategory(workspaceId, campaignId, categoryId, dto)', async () => {
    const dto = { name: 'Renamed' } as UpdateEvergreenCategoryDto;
    await controller.updateCategory(workspaceId, campaignId, categoryId, dto);
    expect(mockService.updateCategory).toHaveBeenCalledWith(
      workspaceId,
      campaignId,
      categoryId,
      dto,
    );
  });

  it('setCategoryActive delegates to service.setCategoryActive(workspaceId, campaignId, categoryId, dto.isActive)', async () => {
    const dto: SetCategoryActiveDto = { isActive: false };
    await controller.setCategoryActive(workspaceId, campaignId, categoryId, dto);
    expect(mockService.setCategoryActive).toHaveBeenCalledWith(
      workspaceId,
      campaignId,
      categoryId,
      false,
    );
  });

  it('removeCategory delegates to service.removeCategory(workspaceId, campaignId, categoryId)', async () => {
    await controller.removeCategory(workspaceId, campaignId, categoryId);
    expect(mockService.removeCategory).toHaveBeenCalledWith(workspaceId, campaignId, categoryId);
  });

  it('addPost delegates to service.addPost(workspaceId, campaignId, categoryId, dto)', async () => {
    const dto = { content: {} } as CreateEvergreenPostDto;
    await controller.addPost(workspaceId, campaignId, categoryId, dto);
    expect(mockService.addPost).toHaveBeenCalledWith(workspaceId, campaignId, categoryId, dto);
  });

  it('updatePost delegates to service.updatePost(workspaceId, campaignId, categoryId, postId, dto)', async () => {
    const dto = { content: {} } as UpdateEvergreenPostDto;
    await controller.updatePost(workspaceId, campaignId, categoryId, postId, dto);
    expect(mockService.updatePost).toHaveBeenCalledWith(
      workspaceId,
      campaignId,
      categoryId,
      postId,
      dto,
    );
  });

  // NOTE ON ROUTE SHAPE: the EvergreenService.updatePost/removePost signatures
  // (Task 4, already committed) are `(workspaceId, campaignId, categoryId, postId, ...)`
  // — categoryId is a required positional arg. The route therefore carries
  // `:catId` for these two endpoints (`.../categories/:catId/posts/:postId`)
  // rather than the flatter `.../posts/:postId` shape, so the controller has
  // something to pass. See task-5-report.md for the full rationale.

  it('removePost delegates to service.removePost(workspaceId, campaignId, categoryId, postId)', async () => {
    await controller.removePost(workspaceId, campaignId, categoryId, postId);
    expect(mockService.removePost).toHaveBeenCalledWith(
      workspaceId,
      campaignId,
      categoryId,
      postId,
    );
  });
});
