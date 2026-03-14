"use client";
import useRouter from "./use-router";

interface LinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Client-side navigation link.
 * Intercepts clicks and delegates to useRouter().push() so the SPA router
 * handles the transition without a full page reload.
 */
const Link = ({ href, children, className }: LinkProps) => {
  const { push } = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    push(href);
  };

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
};

export default Link;