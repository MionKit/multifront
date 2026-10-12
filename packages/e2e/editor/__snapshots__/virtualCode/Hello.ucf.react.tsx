
  export default function Hello({ name }: { name: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p>Hello, {name}!</p>
  }
