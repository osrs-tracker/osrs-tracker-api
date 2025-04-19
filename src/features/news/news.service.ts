import { Injectable } from '@nestjs/common';

@Injectable()
export class NewsService {
  findAll() {
    return [
      { id: '1', title: 'Update 1', content: 'Content 1', date: new Date() },
      { id: '2', title: 'Update 2', content: 'Content 2', date: new Date() },
    ]; // Placeholder data
  }

  findById(id: string) {
    return {
      id,
      title: `News ${id}`,
      content: 'Content details',
      date: new Date(),
    }; // Placeholder data
  }
}
