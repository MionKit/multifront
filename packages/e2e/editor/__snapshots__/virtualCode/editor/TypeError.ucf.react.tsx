
  export default function Total({ count }: { count: number } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    const label: string = count
    return <p>{label}</p>
  }
