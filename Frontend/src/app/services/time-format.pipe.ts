import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'timeFormat',
  standalone: true // Add this if you're using standalone components
})
export class TimeFormatPipe implements PipeTransform {
  transform(value: number): string {
    if (isNaN(value)) return '0:00';
    
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }
}