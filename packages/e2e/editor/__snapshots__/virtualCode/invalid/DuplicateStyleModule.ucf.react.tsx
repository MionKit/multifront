
  export default function DuplicateStyleModule(__props: {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p className={`${$style.first} ${classes.second}`}>Duplicate style module</p>
  }
declare const $style: {readonly fifth: string};
declare const classes: {readonly second: string};
