
  export default function Button({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'button'>>}) {
    return <button className={`button ${classes.primary}`}>{label}</button>
  }
declare const classes: {readonly primary: string};
