import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-bg shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_1px_2px_rgb(11_11_12/0.18),0_8px_20px_-8px_rgb(11_11_12/0.4)] hover:bg-ink/85",
        secondary: "border border-line bg-surface text-ink shadow-[0_1px_2px_rgb(11_11_12/0.04)] hover:border-line-strong hover:bg-surface-2",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
        danger: "bg-challenged text-surface hover:bg-challenged/90",
      },
      size: {
        sm: "h-8 px-3 text-[0.8125rem]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-[0.9375rem]",
        icon: "size-9 rounded-xl",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({ className, variant, size, asChild = false, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
