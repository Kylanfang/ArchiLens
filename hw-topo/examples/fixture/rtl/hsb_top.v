// HSB-style fixture: top + 3 subsystems + vendor primitives.
// Deliberately exercises ANSI ports, parameters, multiple instances,
// comments containing fake instantiations, and string literals.
`default_nettype none

module hsb_top #(
    parameter integer ADDR_W = 32,
    parameter integer DATA_W = 64
) (
    input  wire        clk_i,
    input  wire        rst_ni,
    // host interface
    input  wire        hsb_req_i,
    output wire        hsb_gnt_o,
    // port bench status
    output wire [3:0]  bench_stat_o,
    output wire        error_o
);

    wire        clk_div;
    wire [63:0] dma_wdata;
    wire [31:0] dma_addr;
    wire        dma_valid;
    wire        dma_ready;

    // clock divider with vendor primitive
    clk_div u_clk_div (
        .clk_i    (clk_i),
        .rst_ni   (rst_ni),
        .clk_div_o(clk_div)
    );

    // port bench instances (two channels)
    port_bench #(.CHANNELS(2)) u_bench_ch0 (
        .clk_i    (clk_div),
        .rst_ni   (rst_ni),
        .req_i    (hsb_req_i),
        .gnt_o    (hsb_gnt_o),
        .stat_o   (bench_stat_o[1:0])
    );

    port_bench #(.CHANNELS(2)) u_bench_ch1 (
        .clk_i    (clk_div),
        .rst_ni   (rst_ni),
        .req_i    (hsb_req_i),
        .gnt_o    (),
        .stat_o   (bench_stat_o[3:2])
    );

    // dma engine drives the benches
    dma_engine u_dma (
        .clk_i    (clk_i),
        .rst_ni   (rst_ni),
        .wdata_o  (dma_wdata),
        .addr_o   (dma_addr),
        .valid_o  (dma_valid),
        .ready_i  (dma_ready),
        .error_o  (error_o)
    );

    // A fake instantiation inside a comment must NOT be extracted:
    // fake_module u_fake (.a(b));

    // A fake instantiation inside a string must NOT be extracted:
    // initial $display("also_fake u_also_fake (.x(y));");

endmodule

module clk_div (
    input  wire clk_i,
    input  wire rst_ni,
    output wire clk_div_o
);
    reg [1:0] div_cnt;
    always @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) div_cnt <= 2'd0;
        else         div_cnt <= div_cnt + 2'd1;
    end
    assign clk_div_o = div_cnt[1];
endmodule
