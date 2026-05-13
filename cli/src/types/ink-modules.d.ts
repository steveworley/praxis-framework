declare module 'ink-big-text' {
  import type { FC } from 'react';
  interface BigTextProps {
    text: string;
    font?:
      | 'block'
      | 'slick'
      | 'tiny'
      | 'grid'
      | 'pallet'
      | 'shade'
      | 'simple'
      | 'simpleBlock'
      | 'simple3d'
      | '3d'
      | 'chrome'
      | 'huge';
    colors?: string[];
    backgroundColor?: string;
    align?: 'left' | 'center' | 'right';
    space?: boolean;
    letterSpacing?: number;
    lineHeight?: number;
    maxLength?: number;
  }
  const BigText: FC<BigTextProps>;
  export default BigText;
}

declare module 'ink-gradient' {
  import type { FC, ReactNode } from 'react';
  interface GradientProps {
    name?:
      | 'cristal'
      | 'teen'
      | 'mind'
      | 'morning'
      | 'vice'
      | 'passion'
      | 'fruit'
      | 'instagram'
      | 'atlas'
      | 'retro'
      | 'summer'
      | 'rainbow'
      | 'pastel';
    colors?: string[];
    children?: ReactNode;
  }
  const Gradient: FC<GradientProps>;
  export default Gradient;
}

declare module 'ink-task-list' {
  import type { FC, ReactNode } from 'react';
  interface TaskProps {
    label: string;
    state?: 'pending' | 'loading' | 'success' | 'warning' | 'error';
    status?: string;
    output?: string;
    spinner?: { interval: number; frames: string[] };
    children?: ReactNode;
  }
  interface TaskListProps {
    children?: ReactNode;
  }
  export const Task: FC<TaskProps>;
  export const TaskList: FC<TaskListProps>;
}
