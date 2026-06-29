# Sample file for testing LaTeX Comment Preview.
# Hover over the math below, or move your cursor into one of the math spans.

# The overlap matrix element is the inner product $S_{\mu\nu} = \langle \phi_\mu | \phi_\nu \rangle$.

# Display math also works: $$F\mathbf{c} = \epsilon S \mathbf{c}$$

def scf_energy():
    """
    Computes the SCF energy.

    The Fock matrix is $F = h + \mathbf{J} - \mathbf{K}$ where the exchange term keeps
    same-spin electrons apart. Total energy:

    $$E = \sum_{\mu\nu} P_{\mu\nu} (h_{\mu\nu} + F_{\mu\nu}) / 2$$
    """
    pass

# A line with $ a single dollar and no close should be left alone.
# Plain prose with no math is never rendered, even in a # comment.
# Escaped \$5.00 is not a delimiter.

x = "a string with a # and a $ inside should be ignored"  # but $E=mc^2$ here renders
