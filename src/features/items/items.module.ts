import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { NewItemsController } from './new-items.controller';

@Module({
  controllers: [ItemsController, NewItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
